#!/usr/bin/env bash
# flash-path.sh - Flashes the firmware built in KLIPPER_DIR to a USB-connected MCU
#
# USAGE: flash-path.sh <mcu path> [flash path]
#   mcu path    The MCU's serial link, which comes back once the new firmware runs,
#               for example /dev/RatOS/btt-octopus-max-ez.
#   flash path  The serial link to flash through, if it isn't the MCU path.
#
# Flashing reboots the board into its USB bootloader (DFU). Some boards take several seconds to
# show up in DFU mode, so dfu-util can start before the device exists and the board is left
# waiting in DFU mode. When that happens, the board is flashed again through the DFU USB ID.
#
# Exits 0 when the MCU is back after flashing, and 1 otherwise. A failure is also logged as a
# warning to the RatOS log.

SCRIPT_DIR=$( cd -- "$( dirname -- "$(realpath -- "${BASH_SOURCE[0]}")" )" &> /dev/null && pwd )
# shellcheck source=./configuration/scripts/ratos-common.sh
source "$SCRIPT_DIR"/ratos-common.sh
# shellcheck source=./configuration/scripts/ratos-logging.sh
source "$SCRIPT_DIR"/ratos-logging.sh

MCU=$1
FLASH_PATH=${2:-$MCU}
if [ "$EUID" -ne 0 ]
  then echo "ERROR: Please run as root"
  exit 1
fi
if [ "$MCU" == "" ]; then
	echo "ERROR: Please specify a device to flash"
	exit 1
fi

readonly DFU_USB_ID="0483:df11"
# Seconds to wait for the MCU to come back after flashing
readonly MCU_WAIT_TIMEOUT=${MCU_WAIT_TIMEOUT:-20}
# Seconds a new DFU device has to stay connected before the board counts as stuck in DFU mode.
# A board passes through DFU mode briefly on every flash.
readonly DFU_SETTLE_TIME=${DFU_SETTLE_TIME:-5}

dfu_device_count()
{
	lsusb | grep -c "$DFU_USB_ID"
}

# wait_for_mcu() - Waits for the MCU to come back after flashing
#
# PARAMETERS:
#   $1 - Number of DFU devices connected before flashing
#
# OUTPUT:
#   "mcu" once the MCU's serial link exists, "dfu" once a new DFU device has stayed connected
#   for DFU_SETTLE_TIME seconds, or "timeout" after MCU_WAIT_TIMEOUT seconds.
wait_for_mcu()
{
	local dfu_before=$1
	local dfu_seconds=0
	local deadline=$((SECONDS + MCU_WAIT_TIMEOUT))
	while (( SECONDS < deadline )); do
		if [ -h "$MCU" ]; then
			echo "mcu"
			return
		fi
		if (( $(dfu_device_count) > dfu_before )); then
			dfu_seconds=$((dfu_seconds + 1))
			if (( dfu_seconds >= DFU_SETTLE_TIME )); then
				echo "dfu"
				return
			fi
		else
			dfu_seconds=0
		fi
		sleep 1
	done
	if [ -h "$MCU" ]; then
		echo "mcu"
	else
		echo "timeout"
	fi
}

pushd "${KLIPPER_DIR}" > /dev/null || exit 1
service klipper stop
dfuDevicesPreFlash=$(dfu_device_count)
result="not_connected"
if [ -h "$FLASH_PATH" ]; then
	echo "Flashing $MCU through $FLASH_PATH"
	$SUDO make flash FLASH_DEVICE="$FLASH_PATH"
	result=$(wait_for_mcu "$dfuDevicesPreFlash")
	# Only flash through the DFU USB ID when this board is the only one in DFU mode.
	if [ "$result" != "mcu" ] && [ "$dfuDevicesPreFlash" -eq 0 ] && [ "$(dfu_device_count)" -eq 1 ]; then
		echo "$MCU didn't come back and is in DFU mode. Flashing it through $DFU_USB_ID..."
		$SUDO make flash FLASH_DEVICE="$DFU_USB_ID"
		result=$(wait_for_mcu 1)
	fi
else
	echo "$MCU doesn't seem to be connected, it was not found at $FLASH_PATH"
fi

retVal=1
if [ "$result" == "mcu" ]; then
	retVal=0
	echo "Flashing successful."
else
	echo "Flashing failed."
	if [ "$result" == "not_connected" ]; then
		reason="It was not found at $FLASH_PATH."
	elif [ "$(dfu_device_count)" -gt "$dfuDevicesPreFlash" ]; then
		reason="It is still in DFU mode ($DFU_USB_ID). Flash it from the RatOS configurator before printing."
	else
		reason="It did not come back within ${MCU_WAIT_TIMEOUT}s. Check its connection, then flash it from the RatOS configurator."
	fi
	log_warn "Failed to flash $MCU. $reason" "flash_path" "MCU_FLASH_FAILED"
fi
chown "${RATOS_USERNAME}:${RATOS_USERGROUP}" -R "${KLIPPER_DIR}"
service klipper start
popd > /dev/null || exit $retVal
exit $retVal
