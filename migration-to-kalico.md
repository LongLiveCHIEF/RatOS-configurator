# Testing the RatOS Kalico migration

Nov 23, 2026 · @Brian Vanderbusch

## What this test does

This test moves a printer running RatOS v2.1.x off the RatOS fork of Klipper and onto Kalico, with the features RatOS needs added on top. Both test branches live on the LongLiveCHIEF GitHub account, not the Rat-OS organization.

| Part | Now (RatOS v2.1.x) | During the test |
| --- | --- | --- |
| RatOS configurator | Rat-OS/RatOS-configurator, branch `v2.1.x-deployment-2` | LongLiveCHIEF/RatOS-configurator, branch `topic/devpub/kalico-update-deployment` |
| Klipper | Rat-OS/klipper, branch `ratos/v2.1.x`, commit 2817b348 | LongLiveCHIEF/kalico, branch `add-ratos-dependent-features`, commit 201470df |

What changes on the printer:

- The Klipper folder (`~/klipper`) is switched to Kalico, and RatOS reflashes every board it can flash on its own.
- Klipper's Python environment gets Kalico's packages, including numpy 2 and pygam 0.10.1.
- Kalico's built-in `gcode_shell_command` replaces RatOS's copy. Existing `[gcode_shell_command]` sections keep working.
- Hybrid and IDEX V-Cores use Kalico's `hybrid_corexy` kinematics with `invert_kinematics: True` instead of `ratos_hybrid_corexy`.

Your `printer.cfg` is not regenerated or changed.

## Before you start

Test on an idle printer you can reach over SSH, and that you can flash by hand if you need to. Don't test on a printer with an RMMU: the RMMU module doesn't load on Kalico yet.

1. Check that the configurator is on the v2.1.x release branch. This should print `v2.1.x-deployment-2`:

   ```bash
   git -C ~/ratos-configurator branch --show-current
   ```
2. Check that the Klipper folder has no local changes. This must print nothing, or the migration stops:

   ```bash
   git -C ~/klipper status --short --untracked-files=no
   ```
3. Back up your config, and note the commits you're starting from:

   ```bash
   cp -a ~/printer_data/config ~/printer_data/config-before-kalico
   git -C ~/klipper log -1 --oneline
   git -C ~/ratos-configurator log -1 --oneline
   ```
4. If your printer uses TMC2240 drivers (BTT TMC2240 or LDO 2240 stepsticks, the BTT SB2240 toolboard or the LDO Orbitool O2S), add `rref: 12000` to every `[tmc2240 …]` section in `printer.cfg`. Kalico won't start without it.

RatOS flashes the boards it detects and can flash on its own, which are usually boards connected over USB. Be ready to flash anything else by hand, such as CAN toolboards or boards flashed from an SD card.

## Switch the configurator to the test branch

One `ratos` command switches the configurator and then runs the full RatOS update, which migrates Klipper. Run it over SSH as your normal user (usually `pi`). It asks for your sudo password.

1. Add the test repository as a remote of the configurator:

   ```bash
   git -C ~/ratos-configurator remote add longlivechief https://github.com/LongLiveCHIEF/RatOS-configurator.git
   ```
2. Switch to the test branch:

   ```bash
   ratos development branch longlivechief topic/devpub/kalico-update-deployment
   ```

Use the deployment branch, the one ending in `-deployment`. The command treats any other branch as a developer setup, and turns off the configurator service.

If it asks to recreate the local branch, or to reset a dirty working directory, answer yes. The reset only touches `~/ratos-configurator`, so `printer.cfg` is safe, but edits you made to RatOS's own files under `config/RatOS` are lost.

## Let the update migrate Klipper

The branch command runs the update itself, so there's nothing else to start. It shows these steps in order:

1. Fetching latest changes
2. Copying local environment file
3. Switching to `topic/devpub/kalico-update-deployment`
4. Adjusting environment for deployment branch
5. Updating RatOS configurator
6. Restarting RatOS configurator
7. Updating RatOS configuration. This step migrates Klipper, installs Kalico's Python packages, retires `gcode_shell_extension` and `ratos_hybrid_corexy`, and flashes your boards. It takes the longest, often several minutes.
8. Restarting Klipper
9. Restarting Moonraker

Don't power off the printer during step 7. When the command finishes, check the log for the key lines:

```bash
grep -E "migration completed|Klipper source changed|Flashing connected MCUs|MCU_FLASH_FAILED|MCU_LEFT_IN_DFU|update completed" ~/printer_data/logs/ratos-configurator.log | tail
```

You should see that the migration completed, that the Klipper source changed to `201470df…`, that MCUs were flashed, and `RatOS update completed successfully`. A line with `MCU_FLASH_FAILED` names a board that didn't flash, and `MCU_LEFT_IN_DFU` means a board is still in DFU mode. Flash those boards from the RatOS configurator before printing.

If a step fails, save the log first. Then run `ratos doctor`, which runs the same update again. If only flashing failed, flash those boards from the RatOS configurator in your browser.

While you're testing, Mainsail's update manager may flag ratos-configurator or Klipper, because they're not on the release branches. Don't press Recover on either one.

## Check the result

First confirm the migration over SSH. The comments show the expected output:

```bash
git -C ~/klipper log -1 --oneline                        # starts with 201470df
git -C ~/klipper remote get-url ratos-fork               # https://github.com/LongLiveCHIEF/kalico.git
git -C ~/klipper status --short --untracked-files=no     # prints nothing
git -C ~/ratos-configurator branch --show-current        # topic/devpub/kalico-update-deployment
ls -l ~/klipper/klippy/extras/gcode_shell_command.py     # a regular file, no "->"
ratos extensions list                                    # no gcode_shell_extension or ratos_hybrid_corexy
~/klippy-env/bin/python -c "import numpy, pygam; print(numpy.__version__, pygam.__version__)"   # 2.x 0.10.1
```

Then open Mainsail or Fluidd. Klipper should reach Ready with no "MCU protocol error" or firmware version warnings. If a board shows one, flash that board and restart Klipper.

Next, exercise the parts that changed, keeping a hand near the emergency stop:

| Area | Who | Run | Look for |
| --- | --- | --- | --- |
| Hybrid kinematics | Hybrid and IDEX V-Cores | `G28 X` first, then `G28` | The toolhead moves toward the X endstop, with no "hybrid\_corexy NOT INVERTED" emergency stop |
| Homing | Everyone | `G28` | The Z hop before homing works, with no "Must home axis first" error |
| Bed mesh | Everyone | `BED_MESH_CALIBRATE` | Finishes, with no "timer too close" shutdown, and the mesh shows in the UI |
| Heat soak | Beacon users | `BEACON_WAIT_FOR_PRINTER_HEAT_SOAK`, or a print with heat soak on | Runs to the end with no Python error in `klippy.log` |
| Z offset probe | Printers that use it | `Z_OFFSET_PROBE` | Probes and reports an offset |
| Resonance tools | If you use them | `OSCILLATE`, `MEASURE_LINEAR_VIBRATIONS` | Run to the end; the second needs an accelerometer |
| Printing | Everyone | A normal print; IDEX also a copy and a mirror print | Prints like before |

## Go back to RatOS v2.1.x

Switching back runs the v2.1.x update, which returns Klipper to the RatOS fork at 2817b348 and re-registers RatOS's own extensions. It doesn't reflash your boards, so flash them yourself afterwards.

1. Switch the configurator back to the release branch:

   ```bash
   ratos development branch origin v2.1.x-deployment-2
   ```
2. Flash your boards and restart Klipper. Flash anything that isn't flashed automatically by hand, as before:

   ```bash
   ratos flash
   sudo systemctl restart klipper
   ```
3. Check that Klipper is back on the RatOS fork. This should start with `2817b348`:

   ```bash
   git -C ~/klipper log -1 --oneline
   ```
4. Optionally, remove the test remote:

   ```bash
   git -C ~/ratos-configurator remote remove longlivechief
   ```

You can leave the `rref: 12000` lines in `printer.cfg`, because the RatOS fork accepts them too. Your backup is in `~/printer_data/config-before-kalico` if you need it.

## Report your results

Send a report whether the test worked or not, including:

- Your printer model, mainboard and toolboards, and which boards you had to flash by hand.
- Whether the update finished, or the step where it failed.
- The output of the commands in "Check the result".
- Anything from the table that behaved differently from before.
- Your logs, packed into one file with:

  ```bash
  tar czf ~/kalico-test-logs.tgz -C ~/printer_data/logs ratos-configurator.log klippy.log
  ```

Send your results to the Rat Rig Dev discord and create a thread in the #ratos-testing channel&#32;
