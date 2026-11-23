/* eslint-disable no-console */
import {
	deserializePartialPrinterConfiguration,
	getPrinters,
	loadSerializedConfig,
	getFilesToWrite,
	compareSettings,
	deserializePrinterConfiguration,
} from '@/server/routers/printer';
import { describe, expect, test } from 'vitest';
import { extractToolheadFromPrinterConfiguration, serializePartialToolheadConfiguration } from '@/utils/serialization';
import path from 'path';
import { replaceLinesStartingWith, stripCommentLines, stripIncludes } from '@/server/helpers/metadata';
import { compileFirmware } from '@/server/routers/mcu';
import { ToolheadHelper } from '@/helpers/toolhead';
import { getBoardChipId } from '@/helpers/board';
import { constructKlipperConfigUtils } from '@/server/helpers/klipper-config';
import { sensorlessXTemplate, sensorlessYTemplate } from '@/templates/extras/sensorless-homing';
import { readFile } from 'fs/promises';
import { PrinterConfiguration, SerializedPrinterConfiguration } from '@/zods/printer-configuration';
import { PrinterDefinition } from '@/zods/printer';
import { Accelerometer } from '@/zods/hardware';
import { z } from 'zod';
import { serializePrinterConfiguration } from '@/hooks/usePrinterConfiguration';
import { glob } from 'glob';
import { serverSchema } from '@/env/schema.mjs';
import { existsSync } from 'fs';
import { PrinterAxis } from '@/zods/motion';

const serializedConfigFromDefaults = (printer: PrinterDefinition): SerializedPrinterConfiguration => {
	return SerializedPrinterConfiguration.strip().parse({
		...printer,
		...printer.defaults,
		toolheads: printer.defaults.toolheads.map((t) => {
			if (t.xAccelerometer == null) {
				if (t.toolboard != null) {
					t.xAccelerometer = 'toolboard';
				}
			}
			if (t.yAccelerometer == null) {
				if (t.toolboard != null) {
					t.yAccelerometer = 'toolboard';
				}
			}
			return t;
		}),
		size: printer.sizes[Object.keys(printer.sizes)[0] as keyof typeof printer.sizes],
		controlboard: printer.defaults.board,
		printer: printer.id,
		performanceMode: false,
		standstillStealth: false,
		stealthchop: false,
		controllerFan: printer.defaults.controllerFan ?? '2pin',
		chamberLighting: printer.defaults.chamberLighting,
		toolheadAlignmentSystem: printer.defaults.toolheadAlignmentSystem,
		chamberAirFilter: printer.defaults.chamberAirFilter,
	} satisfies SerializedPrinterConfiguration);
};

const loadConfig = async (path: string) => {
	const config = await loadSerializedConfig(path);
	const files = await getFilesToWrite(config);
	const res: string = files.find((f) => f.fileName === 'RatOS.cfg')?.content ?? '';
	const splitRes = res.split('\n');
	const annotatedLines = splitRes.map((l: string, i: number) => `Line-${i + 1}`.padEnd(10, '-') + `|${l}`);
	return {
		splitRes,
		annotatedLines,
		config,
		files,
	};
};

const expectValidConfig = async (config: PrinterConfiguration, splitRes: string[], annotatedLines: string[]) => {
	const noUndefined = splitRes.filter((l: string) => l.includes('undefined')).join('\n');
	const noPromises = splitRes.filter((l: string) => l.includes('[object Promise]')).join('\n');
	const noObjects = splitRes.filter((l: string) => l.includes('[object Object]')).join('\n');
	if (noUndefined || noPromises || noObjects) {
		console.log(annotatedLines.join('\n'));
	}
	expect(noUndefined, 'Expected no undefined values in config').to.eq('');
	expect(noPromises, 'Expected no promises in config').to.eq('');
	expect(noObjects, 'Expected no objects in config').to.eq('');
};

describe('server', async () => {
	const parsedPrinters = await getPrinters();
	describe('metadata', async () => {
		test.concurrent('can strip comments', () => {
			const test = `
				# this is a comment
				[include]
			`;
			const result = stripCommentLines(test);
			expect(result).toEqual(`
				[include]
			`);
		});
		test.concurrent('can strip includes', () => {
			const test = `
				# this is a comment
				[include RatOS/extruder/test.cfg]
			`;
			const result = stripIncludes(test);
			expect(result).toEqual(`
				# this is a comment
			`);
		});
		test.concurrent('can replace a pin', () => {
			const test = `
				# this is a comment
				[include RatOS/extruder/test.cfg]
				[extruder]
				heater_pin: bad_pin
			`;
			const result = replaceLinesStartingWith(test, 'heater_pin', '				heater_pin: good_pin');
			expect(result).toEqual(`
				# this is a comment
				[include RatOS/extruder/test.cfg]
				[extruder]
				heater_pin: good_pin
			`);
		});
	});
	describe('serialization', async () => {
		test.concurrent('can deserialize toolheads from printer configuration files', async () => {
			const parsedPrintersWithDeserializedToolheads = await getPrinters(true);
			expect(parsedPrintersWithDeserializedToolheads.length).toEqual(parsedPrinters.length);
			parsedPrinters.forEach((p) => {
				expect(p.defaults.toolheads.length).toBeGreaterThan(0);
				p.defaults.toolheads.forEach((t) => {
					expect(t).not.toBeNull();
				});
			});
		});
		test.concurrent('can deserialize toolheads from a partial printer config', async () => {
			await Promise.all(
				parsedPrinters.map(async (p) => {
					const config = await deserializePartialPrinterConfiguration({
						printer: p.id,
						rails: p.defaults.rails,
						toolheads: p.defaults.toolheads,
						controlboard: p.defaults.board,
					});
					expect(config).not.toBeNull();
					expect(config?.printer?.id).toEqual(p.id);
					expect(config?.toolheads).toBeDefined();
					expect(config?.toolheads?.length).toEqual(p.defaults.toolheads.length);
					expect(config?.rails?.length).toEqual(p.defaults.rails.length);
					for (const toolhead of config!.toolheads!) {
						expect(toolhead).toBeDefined();
						if (toolhead == null) {
							return;
						}
						const th = extractToolheadFromPrinterConfiguration(toolhead.axis!, config)?.serialize();
						expect(th).toBeDefined();
						const reserialized = serializePartialToolheadConfiguration(toolhead)!;
						expect(th).toEqual(reserialized);
						Object.keys(toolhead).forEach((key) => {
							if (key === 'axis') {
								return;
							}
							expect(th?.[key as keyof typeof toolhead]).toEqual(reserialized[key as keyof typeof reserialized]);
						});
					}
				}),
			);
		});
		test.concurrent('results in the same serialized config after reserializing a deserialized config', async () => {
			await Promise.all(
				parsedPrinters
					.map((p) => {
						return serializedConfigFromDefaults(p);
					})
					.concat(
						await Promise.all(
							(await glob('**/*.json', { cwd: path.join(__dirname, 'fixtures') })).map(async (fixtureFile) => {
								const file = await readFile(path.join(__dirname, 'fixtures', fixtureFile));
								return SerializedPrinterConfiguration.parse(JSON.parse(file.toString()));
							}),
						),
					)
					.map(async (serialized) => {
						const deserialized = await deserializePrinterConfiguration(serialized);
						const reserialized = serializePrinterConfiguration(deserialized);
						if (
							(serialized.size == null || typeof serialized.size !== 'object') &&
							typeof reserialized.size === 'object'
						) {
							// Handle PrinterConfiguration zod transform
							if (serialized.size == null) {
								expect(reserialized.size).toEqual(
									deserialized.printer.sizes[Object.keys(deserialized.printer.sizes)[0]],
								);
							} else {
								expect(reserialized.size?.x).toEqual(serialized.size);
							}
							serialized.size = reserialized.size;
						}
						expect(reserialized).toEqual(serialized);
					}),
			);
		});
	});

	describe('printer schema validation', async () => {
		test.concurrent('rejects template with directory traversal (..)', async () => {
			const p = { ...parsedPrinters[0], template: '../evil-printer-printer.template.cfg' };
			expect(() => PrinterDefinition.parse(p)).toThrow(/Invalid template filename/);
		});

		test.concurrent('rejects absolute template paths', async () => {
			const p = { ...parsedPrinters[0], template: '/etc/passwd-printer.template.cfg' };
			expect(() => PrinterDefinition.parse(p)).toThrow(/Invalid template filename/);
		});

		test.concurrent('accepts normal relative template paths', async () => {
			const p = { ...parsedPrinters[0], template: 'v-core-200-printer.template.cfg' };
			expect(PrinterDefinition.parse(p).template).toEqual(p.template);
		});
	});
	describe('regression tests', async () => {
		describe('can generate a default v-core config', async () => {
			const vCoreConfigPath = path.join(__dirname, 'fixtures', 'v-core-200.json');
			const { splitRes, annotatedLines, config } = await loadConfig(vCoreConfigPath);
			const gcodeBlocks: number[] = [];
			splitRes.forEach((l, i) => l.includes('gcode:') && gcodeBlocks.push(i));
			test('produces valid config', async () => {
				expectValidConfig(config, splitRes, annotatedLines);
			});
			test('can diff files', async () => {
				const configJson = await readFile(vCoreConfigPath);
				const serializedConfig = SerializedPrinterConfiguration.parse(JSON.parse(configJson.toString()));
				compareSettings(serializedConfig);
			});
			test.runIf(gcodeBlocks.length > 0)('correctly indents gcode blocks', async () => {
				for (const block of gcodeBlocks) {
					try {
						expect(splitRes[block + 1].startsWith('\t') || splitRes[block + 1].startsWith('  ')).toBeTruthy();
					} catch (e) {
						throw new Error(
							`Failed to indent gcode block at line ${block + 1}:\n${annotatedLines.slice(block - 4, block + 5).join('\n')}`,
						);
					}
				}
			});
		});
		/*
		describe('can generate config with filament sensor', async () => {			
			const vCoreWithSensorConfigPath = path.join(__dirname, 'fixtures', 'v-core-200-with-filament-sensor.json');
			const { splitRes, annotatedLines, config } = await loadConfig(vCoreWithSensorConfigPath);
			test('produces valid config', async () => {
				expectValidConfig(config, splitRes, annotatedLines);
			});
			test('does not include filament sensor when pins are not defined', async () => {
				// Since boards don't have filament_sensor_runout_pin and filament_sensor_motion_pin defined yet,
				// the filament sensor section should NOT be rendered
				const sensorSection = splitRes.find((l) => l.includes('[filament_switch_sensor'));
				expect(sensorSection).toBeUndefined();
			});		
		});
		*/
		describe('can generate idex config', async () => {
			const idexConfigPath = path.join(__dirname, 'fixtures', 'idex-config.json');
			const { splitRes, annotatedLines, config } = await loadConfig(idexConfigPath);
			const gcodeBlocks: number[] = [];
			splitRes.forEach((l, i) => l.includes('gcode:') && gcodeBlocks.push(i));
			test('produces valid config', async () => {
				expectValidConfig(config, splitRes, annotatedLines);
			});
			test.runIf(gcodeBlocks.length > 0)('correctly indents gcode blocks', async () => {
				for (const block of gcodeBlocks) {
					try {
						expect(splitRes[block + 1].startsWith('\t') || splitRes[block + 1].startsWith('  ')).toBeTruthy();
					} catch (e) {
						throw new Error(
							`Failed to indent gcode block at line ${block + 1}:\n${annotatedLines.slice(block - 4, block + 5).join('\n')}`,
						);
					}
				}
			});
		});
		describe('can generate a valid mk3s config', async () => {
			const prusaMk3sConfigPath = path.join(__dirname, 'fixtures', 'prusa-mk3s.json');
			const { splitRes, annotatedLines, config, files } = await loadConfig(prusaMk3sConfigPath);
			test('produces valid config', async () => {
				expectValidConfig(config, splitRes, annotatedLines);
			});
			const resonanceTesterBlocks: number[] = [];
			splitRes.forEach((l, i) => l.includes('[resonance_tester]') && resonanceTesterBlocks.push(i));
			test('does not include resonance tester in the config', async () => {
				for (const block of resonanceTesterBlocks) {
					try {
						expect(splitRes[block].includes('[resonance_tester]')).toBeFalsy();
					} catch (e) {
						throw new Error(
							`Found resonance tester in the config:\n${annotatedLines.slice(block - 4, block + 5).join('\n')}`,
						);
					}
				}
			});
			const sensorlessBlocks: number[] = [];
			const endstopBlocks: number[] = [];
			splitRes.forEach((l, i) => l.includes('[include sensorless-homing') && sensorlessBlocks.push(i));
			splitRes.forEach((l, i) => l.includes('variable_homing_x: "endstop"') && endstopBlocks.push(i));
			splitRes.forEach((l, i) => l.includes('variable_homing_y: "endstop"') && endstopBlocks.push(i));
			test('correctly configures sensorless homing', async () => {
				try {
					expect(endstopBlocks.length).toBeLessThan(1);
				} catch (e) {
					throw new Error(
						`Found endstop configuration:\n${annotatedLines.slice(endstopBlocks[0] - 4, endstopBlocks[0] + 5).join('\n')}`,
					);
				}
				expect(sensorlessBlocks.length).toBe(2);
			});
			test('correctly comments out generated sensorless defaults', async () => {
				expect(files.find((f) => f.fileName === 'sensorless-homing-x.cfg')?.content).toContain(
					'#variable_sensorless_x_current: ',
				);
				expect(files.find((f) => f.fileName === 'sensorless-homing-y.cfg')?.content).toContain(
					'#variable_sensorless_y_current: ',
				);
				expect(files.find((f) => f.fileName === 'sensorless-homing-x.cfg')?.content).toContain('#driver_SGT: 0');
				expect(files.find((f) => f.fileName === 'sensorless-homing-y.cfg')?.content).toContain('#driver_SGT: 0');
			});
		});
		describe('can generate another idex config', async () => {
			const idexConfigPath = path.join(__dirname, 'fixtures', 'another-idex.json');
			const { splitRes, annotatedLines, config } = await loadConfig(idexConfigPath);
			const gcodeBlocks: number[] = [];
			splitRes.forEach((l, i) => l.includes('gcode:') && gcodeBlocks.push(i));
			test('produces valid config', async () => {
				expect(splitRes.length).toBeGreaterThan(0);
				const noUndefined = splitRes.filter((l: string) => l.includes('undefined')).join('\n');
				const noNull = splitRes.filter((l: string) => l.includes(':null')).join('\n');
				const noPromises = splitRes.filter((l: string) => l.includes('[object Promise]')).join('\n');
				const noObjects = splitRes.filter((l: string) => l.includes('[object Object]')).join('\n');
				if (noUndefined || noPromises || noObjects) {
					console.log(annotatedLines.join('\n'));
				}
				expect(noUndefined, 'Expected no undefined values in config').to.eq('');
				expect(noNull, 'Expected no null values in config').to.eq('');
				expect(noPromises, 'Expected no promises in config').to.eq('');
				expect(noObjects, 'Expected no objects in config').to.eq('');
			});
			test.runIf(gcodeBlocks.length > 0)('correctly indents gcode blocks', async () => {
				for (const block of gcodeBlocks) {
					try {
						expect(splitRes[block + 1].startsWith('\t') || splitRes[block + 1].startsWith('  ')).toBeTruthy();
					} catch (e) {
						throw new Error(
							`Failed to indent gcode block at line ${block + 1}:\n${annotatedLines.slice(block - 4, block + 5).join('\n')}`,
						);
					}
				}
			});
		});
		describe('can resolve pins that are only defined in motorslots and not aliases', async () => {
			const idexConfigPath = path.join(__dirname, 'fixtures', 'idex-undefined-pins.json');
			const { splitRes, annotatedLines, config } = await loadConfig(idexConfigPath);
			const suspectedMissingPins: string[] = [
				`y1_step_pin=`,
				`y1_dir_pin=`,
				`y1_enable_pin=`,
				`y1_uart_pin=`,
				`y1_diag_pin=`,
				`y1_endstop_pin=`,
				`dual_carriage_step_pin=`,
				`dual_carriage_dir_pin=`,
				`dual_carriage_enable_pin=`,
				`dual_carriage_uart_pin=`,
				`dual_carriage_diag_pin=`,
				`dual_carriage_endstop_pin=`,
				`dual_carriage_step_pin=`,
				`dual_carriage_dir_pin=`,
				`dual_carriage_enable_pin=`,
				`dual_carriage_uart_pin=`,
				`dual_carriage_diag_pin=`,
				`dual_carriage_endstop_pin=`,
			];
			test('produces valid config', async () => {
				expect(splitRes.length).toBeGreaterThan(0);
				const noUndefined = splitRes.filter((l: string) => l.includes('undefined')).join('\n');
				const noNull = splitRes.filter((l: string) => l.includes(':null')).join('\n');
				const noPromises = splitRes.filter((l: string) => l.includes('[object Promise]')).join('\n');
				const noObjects = splitRes.filter((l: string) => l.includes('[object Object]')).join('\n');
				if (noUndefined || noPromises || noObjects) {
					console.log(annotatedLines.join('\n'));
				}
				expect(noUndefined, 'Expected no undefined values in config').to.eq('');
				expect(noNull, 'Expected no null values in config').to.eq('');
				expect(noPromises, 'Expected no promises in config').to.eq('');
				expect(noObjects, 'Expected no objects in config').to.eq('');
			});
			test('contains undefined motor slot pins', async () => {
				const errors: string[] = [];
				suspectedMissingPins.forEach((pin) => {
					try {
						expect(
							splitRes.some((l) => l.includes(`\t` + pin)),
							`Expected config to contain "${pin}" alias.`,
						).toBeTruthy();
					} catch (e) {
						if (!(e instanceof Error)) {
							throw e;
						}
						errors.push(e.message);
					}
				});
				if (errors.length > 0) {
					throw new Error('\n' + errors.join('\n'));
				}
			});
		});
		describe('can generate hybrid config with toolboard', async () => {
			let debugLines: string[] = [];
			let generatedLines: string[] = [];
			test('produces valid config', async () => {
				const hybridConfigPath = path.join(__dirname, 'fixtures', 'hybrid-config.json');
				const { splitRes, annotatedLines, config } = await loadConfig(hybridConfigPath);
				expect(config.printer.kinematics).toEqual('hybrid-corexy');
				debugLines = annotatedLines;
				generatedLines = splitRes;
				expectValidConfig(config, splitRes, annotatedLines);
				expect(generatedLines.includes(`variable_x_axes: ["x"]`)).toBeTruthy();
				expect(generatedLines.includes(`variable_x_driver_types: ["tmc2209"]`)).toBeTruthy();
				expect(generatedLines.includes(`variable_y_axes: ["x1", "y", "y1"]`)).toBeTruthy();
				expect(generatedLines.includes(`variable_y_driver_types: ["tmc2209", "tmc2209", "tmc2209"]`)).toBeTruthy();
			});
			test.concurrent('uses the correct heater fan', async () => {
				const sectionIndex = debugLines.findIndex((l) => l.includes('[heater_fan toolhead_cooling_fan]'));
				const commentIndex = debugLines
					.slice(sectionIndex > -1 ? sectionIndex : 0)
					.findIndex((l) => l.includes(`# 2-pin fan connected to 2-pin header on T0 (EBB42 v1.2) - input voltage pwm`));
				const pinIndex = debugLines
					.slice(sectionIndex > -1 ? sectionIndex : 0)
					.findIndex((l) => l.includes('pin: toolboard_t0:PA1'));
				expect(sectionIndex, 'Expected [heater_fan toolhead_cooling_fan] section present').toBeGreaterThan(-1);
				expect(commentIndex, 'Expected 2-pin toolboard fan comment').toEqual(3);
				expect(pinIndex, 'expected toolboard fan pin').toEqual(commentIndex! + 1);
			});
			test.concurrent('uses the correct part fan', async () => {
				const sectionIndex = debugLines.findIndex((l) => l.includes('[fan]'));
				const commentIndex = debugLines
					.slice(sectionIndex > -1 ? sectionIndex : 0)
					.findIndex((l) => l.includes(`# 4-pin fan connected to 2-pin header on T0 (EBB42 v1.2) - digital pwm`));
				const pinIndex = debugLines
					.slice(sectionIndex > -1 ? sectionIndex : 0)
					.findIndex((l) => l.includes('pin: !toolboard_t0:PA0'));
				expect(sectionIndex, 'Expected [fan] section present').toBeGreaterThan(-1);
				expect(commentIndex, 'Expected 4-pin toolboard fan comment').toEqual(1);
				expect(pinIndex, 'expected toolboard fan pin').toEqual(commentIndex! + 1);
			});
			test.concurrent('can render sensorless homing files', async () => {
				const config = await loadSerializedConfig(path.join(__dirname, 'fixtures', 'hybrid-config.json'));
				const utils = await constructKlipperConfigUtils(config);
				const x = sensorlessXTemplate(config, utils, false);
				const y = sensorlessYTemplate(config, utils, false);
				expect(x).toContain('variable_sensorless_x_current:');
				expect(y).toContain('variable_sensorless_y_current:');
				expect(x).toContain('driver_SGTHRS:');
				expect(y).toContain('driver_SGTHRS:');
			});
		});
		describe('can generate v-minion config', async () => {
			const minionConfigPath = path.join(__dirname, 'fixtures', 'minion-config.json');
			const { splitRes, annotatedLines, config, files } = await loadConfig(minionConfigPath);
			const printerCfg = files.find((f) => f.fileName === 'printer.cfg')?.content ?? '';
			const splitPrinterCfg = printerCfg.split('\n');
			const annotatedPrinterCfgLines = splitPrinterCfg.map(
				(l: string, i: number) => `Line-${i + 1}`.padEnd(10, '-') + `|${l}`,
			);
			const gcodeBlocks: number[] = [];
			splitRes.forEach((l, i) => l.includes('gcode:') && gcodeBlocks.push(i));
			test('produces valid config', async () => {
				expectValidConfig(config, splitRes, annotatedLines);
			});
			test.runIf(gcodeBlocks.length > 0)('correctly indents gcode blocks', async () => {
				for (const block of gcodeBlocks) {
					try {
						expect(splitRes[block + 1].startsWith('\t') || splitRes[block + 1].startsWith('  ')).toBeTruthy();
					} catch (e) {
						throw new Error(
							`Failed to indent gcode block at line ${block + 1}:\n${annotatedLines.slice(block - 4, block + 5).join('\n')}`,
						);
					}
				}
			});
			test.concurrent('properly sets x and y accelerometers', () => {
				const xSections: number[] = [];
				const ySections: number[] = [];
				const getAccelChipName = (id: z.infer<typeof Accelerometer>['id']) => {
					switch (id) {
						case 'none':
							return 'none';
						case 'sbc':
							return 'rpi';
						case 'controlboard':
							return 'controlboard';
						case 'toolboard':
							return 'toolboard_t0';
					}
				};
				splitRes.forEach((l, i) => {
					if (l.startsWith('accel_chip_x')) {
						xSections.push(i);
						if (l !== `accel_chip_x: adxl345 ${getAccelChipName(config.toolheads[0].xAccelerometer?.id ?? 'none')}`) {
							throw new Error(
								`Incorrect accel_chip_x at at line ${i + 1}:\n${annotatedLines.slice(Math.max(i - 4, 0), Math.min(i + 5, annotatedLines.length)).join('\n')}`,
							);
						}
					}
					if (l.startsWith('accel_chip_y')) {
						ySections.push(i);
						if (l !== `accel_chip_y: adxl345 ${getAccelChipName(config.toolheads[0].yAccelerometer?.id ?? 'none')}`) {
							throw new Error(
								`Incorrect accel_chip_y at at line ${i + 1}:\n${annotatedLines.slice(Math.max(i - 4, 0), Math.min(i + 5, annotatedLines.length)).join('\n')}`,
							);
						}
					}
				});
				if (config.toolheads[0].xAccelerometer?.id !== 'none') {
					expect(xSections.length).toBeGreaterThan(0);
				}
				if (config.toolheads[0].yAccelerometer?.id !== 'none') {
					expect(ySections.length).toBeGreaterThan(0);
				}
			});
			test.concurrent('contains position_min/max/endstop for x/y', () => {
				const combined = [...splitRes, ...splitPrinterCfg];
				const xSections: number[] = [];
				const ySections: number[] = [];
				combined.forEach((l, i) => {
					l.startsWith('[stepper_x]') && xSections.push(i);
					l.startsWith('[stepper_y]') && ySections.push(i);
				});
				[xSections, ySections].forEach((sections, i) => {
					const sectionName = ['x', 'y', 'z'][i];
					let hasMin = false;
					let hasMax = false;
					let hasEndstop = false;
					sections.forEach((i) => {
						const nextSection = combined.slice(i + 1).findIndex((l) => l.trim().startsWith('['));
						hasMin = combined.slice(i, i + nextSection).find((l) => l.includes('position_min:')) != null || hasMin;
						hasMax = combined.slice(i, i + nextSection).find((l) => l.includes('position_max:')) != null || hasMax;
						hasEndstop =
							combined.slice(i, i + nextSection).find((l) => l.includes('position_endstop:')) != null || hasEndstop;
					});
					try {
						expect(hasMin, `[stepper_${sectionName}] is missing position_min`).toBeTruthy();
						expect(hasMax, `[stepper_${sectionName}] is missing position_max`).toBeTruthy();
						expect(hasEndstop, `[stepper_${sectionName}] is missing position_endstop`).toBeTruthy();
					} catch (e) {
						console.log(annotatedLines.join('\n'));
						console.log(annotatedPrinterCfgLines.join('\n'));
						throw e;
					}
				});
			});
		});
		describe('can generate idex-with-double-orbitools config', async () => {
			const idexWithDoubleOrbitoolsConfigPath = path.join(__dirname, 'fixtures', 'idex-with-double-orbitools.json');
			const { splitRes, annotatedLines, config, files } = await loadConfig(idexWithDoubleOrbitoolsConfigPath);
			const gcodeBlocks: number[] = [];
			splitRes.forEach((l, i) => l.includes('gcode:') && gcodeBlocks.push(i));
			test('produces valid config', async () => {
				expectValidConfig(config, splitRes, annotatedLines);
			});
			test('contains correct lis2dw accelerometers', () => {
				const accelLineIndex = splitRes.findIndex((l) => l.includes('variable_adxl_chip: '));
				expect(accelLineIndex).toBeGreaterThan(-1);
				const accelLine = splitRes[accelLineIndex];
				const x = accelLine.includes('lis2dw toolboard_t0');
				const y = accelLine.includes('lis2dw toolboard_t1');
				try {
					expect(x, 'Expected lis2dw toolboard_t0 in accelLine').toBeTruthy();
				} catch (e) {
					throw new Error(
						`Incorrect variable_adxl_chip, expected lis2dw toolboard_t0 to be found in line ${accelLineIndex + 1}:\n${annotatedLines.slice(Math.max(accelLineIndex - 4, 0), Math.min(accelLineIndex + 5, annotatedLines.length)).join('\n')}`,
					);
				}
				try {
					expect(y, 'Expected lis2dw toolboard_t1 in accelLine').toBeTruthy();
				} catch (e) {
					throw new Error(
						`Incorrect variable_adxl_chip, expected lis2dw toolboard_t1 to be found in line ${accelLineIndex + 1}:\n${annotatedLines.slice(Math.max(accelLineIndex - 4, 0), Math.min(accelLineIndex + 5, annotatedLines.length)).join('\n')}`,
					);
				}
			});
		});
		describe('can generate voron-v24 config', async () => {
			const voronV24ConfigPath = path.join(__dirname, 'fixtures', 'voron-v24-300.json');
			const { splitRes, annotatedLines, config, files } = await loadConfig(voronV24ConfigPath);
			const gcodeBlocks: number[] = [];
			splitRes.forEach((l, i) => l.includes('gcode:') && gcodeBlocks.push(i));
			test('produces valid config', async () => {
				expectValidConfig(config, splitRes, annotatedLines);
				// Expect gear_ratio to be set for z1, z2, z3, z4
				expect(config.rails.find((r) => r.axis === PrinterAxis.z)?.gearRatio).toEqual('80:16');
				expect(config.rails.find((r) => r.axis === PrinterAxis.z1)?.gearRatio).toEqual('80:16');
				expect(config.rails.find((r) => r.axis === PrinterAxis.z2)?.gearRatio).toEqual('80:16');
				expect(config.rails.find((r) => r.axis === PrinterAxis.z3)?.gearRatio).toEqual('80:16');
				// Expect gear_ratio to be present in splitRes
				expect(splitRes.filter((l) => l.includes('gear_ratio:')).length).toBe(5);
			});
			test('sets rref for the TMC2240 extruder driver', async () => {
				const start = splitRes.findIndex((l) => l.trim() === '[tmc2240 extruder]');
				expect(start, 'missing [tmc2240 extruder] section').toBeGreaterThan(-1);
				const end = splitRes.findIndex((l, i) => i > start && l.startsWith('['));
				const section = splitRes.slice(start, end === -1 ? undefined : end);
				expect(section).toContain('rref: 12000');
				expect(section.some((l) => l.startsWith('sense_resistor:'))).toBe(false);
			});
		});
	});
	describe('printer defaults', async () => {
		const printers = await getPrinters();
		describe.each(printers)('can generate a default config for $manufacturer $name', async (printer) => {
			const serialized = serializedConfigFromDefaults(printer);
			const config = await deserializePrinterConfiguration(serialized);
			test('defaults resolve to valid config', async () => {
				expect(config).not.toBeNull();
				expect(config?.printer?.id).toEqual(printer.id);
				expect(config?.toolheads).toBeDefined();
				expect(config?.toolheads?.length).toEqual(printer.defaults.toolheads.length);
				expect(config?.rails?.length).toEqual(printer.defaults.rails.length);
				for (const toolhead of config!.toolheads!) {
					expect(toolhead).toBeDefined();
					if (toolhead == null) {
						return;
					}
					const th = extractToolheadFromPrinterConfiguration(toolhead.axis!, config)?.serialize();
					expect(th).toBeDefined();
					const reserialized = serializePartialToolheadConfiguration(toolhead)!;
					expect(th).toEqual(reserialized);
					Object.keys(toolhead).forEach((key) => {
						if (key === 'axis') {
							return;
						}
						expect(th?.[key as keyof typeof toolhead]).toEqual(reserialized[key as keyof typeof reserialized]);
					});
				}
			});
			describe.each(await getFilesToWrite(config))('defaults generate valid content for $fileName', async (res) => {
				const splitRes = res.content.split('\n');
				const annotatedLines = splitRes.map((l: string, i: number) => `Line-${i + 1}`.padEnd(10, '-') + `|${l}`);
				test('not empty', () => {
					expect(splitRes.length).toBeGreaterThan(0);
				});
				test('no invalid stringification', () => {
					const noUndefined = splitRes.findIndex((l: string) => l.includes('undefined'));
					const noPromises = splitRes.findIndex((l: string) => l.includes('[object Promise]'));
					const noObjects = splitRes.findIndex((l: string) => l.includes('[object Object]'));
					try {
						expect(noUndefined, 'Expected no undefined values in config').to.eq(-1);
					} catch (e) {
						throw new Error(
							`Found stringified undefined ${noUndefined + 1}:\n${annotatedLines.slice(Math.max(noUndefined - 4, 0), Math.min(annotatedLines.length, noUndefined + 5)).join('\n')}`,
						);
					}
					try {
						expect(noPromises, 'Expected no promises in config').to.eq(-1);
					} catch (e) {
						throw new Error(
							`Found stringified promise ${noUndefined + 1}:\n${annotatedLines.slice(Math.max(noUndefined - 4, 0), Math.min(annotatedLines.length, noUndefined + 5)).join('\n')}`,
						);
					}
					try {
						expect(noObjects, 'Expected no objects in config').to.eq(-1);
					} catch (e) {
						throw new Error(
							`Found stringified object ${noUndefined + 1}:\n${annotatedLines.slice(Math.max(noUndefined - 4, 0), Math.min(annotatedLines.length, noUndefined + 5)).join('\n')}`,
						);
					}
				});
				test('contain valid includes', async () => {
					const includes = splitRes.filter((l) => l.includes('[include '));
					const invalidIncludes = includes.filter((l) => !l.includes('[include RatOS'));
					const env = serverSchema.parse(process.env);
					includes
						.filter((l) => l.includes('[include RatOS/'))
						.forEach((l) => {
							try {
								expect(
									existsSync(path.join(env.RATOS_CONFIGURATION_PATH, l.split('[include RatOS/')[1].replace(']', ''))),
								).toBeTruthy();
							} catch (e) {
								const index = splitRes.findIndex((line) => line === l);
								throw new Error(
									`Found non existing include ${l}:\n${annotatedLines
										.slice(Math.max(index - 4, 0), Math.min(index + 5, splitRes.length))
										.join('\n')}`,
								);
							}
						});
				});
				test.runIf(res.fileName === 'printer.cfg').concurrent('contains position_min/max/endstop for x/y', async () => {
					const xSections: number[] = [];
					const ySections: number[] = [];
					splitRes.forEach((l, i) => {
						l.startsWith('[stepper_x]') && xSections.push(i);
						l.startsWith('[stepper_y]') && ySections.push(i);
					});
					[xSections, ySections].forEach((sections, i) => {
						const sectionName = ['x', 'y', 'z'][i];
						let hasMin = false;
						let hasMax = false;
						let hasEndstop = false;
						sections.forEach((i) => {
							const nextSection = splitRes.slice(i + 1).findIndex((l) => l.trim().startsWith('['));
							hasMin = splitRes.slice(i, i + nextSection).find((l) => l.includes('position_min:')) != null || hasMin;
							hasMax = splitRes.slice(i, i + nextSection).find((l) => l.includes('position_max:')) != null || hasMax;
							hasEndstop =
								splitRes.slice(i, i + nextSection).find((l) => l.includes('position_endstop:')) != null || hasEndstop;
						});
						try {
							expect(hasMin, `[stepper_${sectionName}] is missing position_min`).toBeTruthy();
							expect(hasMax, `[stepper_${sectionName}] is missing position_max`).toBeTruthy();
							expect(hasEndstop, `[stepper_${sectionName}] is missing position_endstop`).toBeTruthy();
						} catch (e) {
							console.log(annotatedLines.join('\n'));
							throw e;
						}
					});
				});
				test.runIf(res.fileName === 'printer.cfg').concurrent('contains no RatOS managed parameters', async () => {
					const offendingLines: { line: number; param: string }[] = [];
					const offendingStrings = ['nozzle_diameter', 'variable_hotend_type', 'variable_has_cht_nozzle'];
					splitRes.forEach((l, i) => {
						offendingStrings.forEach((s) => {
							if (l.startsWith(s)) {
								offendingLines.push({ line: i, param: s });
							}
						});
					});
					for (const { line, param } of offendingLines) {
						try {
							expect(splitRes[line + 1].startsWith('\t') || splitRes[line + 1].startsWith('  ')).toBeTruthy();
						} catch (e) {
							throw new Error(
								`Illegal parameter "${param}" at line ${line + 1}:\n${annotatedLines.slice(Math.max(line - 4, 0), Math.min(line + 5, annotatedLines.length)).join('\n')}`,
							);
						}
					}
				});
				test.concurrent('properly indents gcode blocks', async () => {
					const gcodeBlocks: number[] = [];
					splitRes.forEach((l, i) => l.includes('gcode:') && gcodeBlocks.push(i));
					for (const block of gcodeBlocks) {
						try {
							expect(
								splitRes[block + 1].startsWith('\t') ||
									splitRes[block + 1].startsWith('#\t') ||
									splitRes[block + 1].startsWith('  ') ||
									splitRes[block + 1].startsWith('#  '),
							).toBeTruthy();
						} catch (e) {
							throw new Error(
								`Failed to indent gcode block at line ${block + 1}:\n${annotatedLines.slice(Math.max(block - 4, 0), Math.min(block + 5, annotatedLines.length)).join('\n')}`,
							);
						}
					}
				});
			});
			test('can be compared', () => {
				compareSettings(serialized);
			});
		});
		const fixtures = await Promise.all(
			glob.sync(path.join(__dirname, 'fixtures', '*.json')).map(async (fixture) => {
				return {
					fixture: await import(fixture),
					fixtureFile: path.basename(fixture),
				};
			}),
		);
		describe.each(fixtures)('can generate a config from fixtures/$fixtureFile', async (printer) => {
			const serialized = printer.fixture;
			const config = await deserializePrinterConfiguration(serialized);
			test('fixture resolves to valid config', async () => {
				expect(config).not.toBeNull();
				expect(config?.printer?.id).toBeDefined();
				expect(config?.toolheads).toBeDefined();
				expect(config?.toolheads?.length).toBeGreaterThan(0);
				expect(config?.rails?.length).toBeGreaterThan(0);
				for (const toolhead of config!.toolheads!) {
					expect(toolhead).toBeDefined();
					if (toolhead == null) {
						return;
					}
					const th = extractToolheadFromPrinterConfiguration(toolhead.axis!, config)?.serialize();
					expect(th).toBeDefined();
					const reserialized = serializePartialToolheadConfiguration(toolhead)!;
					expect(th).toEqual(reserialized);
					Object.keys(toolhead).forEach((key) => {
						if (key === 'axis') {
							return;
						}
						expect(th?.[key as keyof typeof toolhead]).toEqual(reserialized[key as keyof typeof reserialized]);
					});
				}
			});
			describe.each(await getFilesToWrite(config))('fixture generates valid content for $fileName', async (res) => {
				const splitRes = res.content.split('\n');
				const annotatedLines = splitRes.map((l: string, i: number) => `Line-${i + 1}`.padEnd(10, '-') + `|${l}`);
				test('not empty', () => {
					expect(splitRes.length).toBeGreaterThan(0);
				});
				test('no invalid stringification', () => {
					const noUndefined = splitRes.findIndex((l: string) => l.includes('undefined'));
					const noPromises = splitRes.findIndex((l: string) => l.includes('[object Promise]'));
					const noObjects = splitRes.findIndex((l: string) => l.includes('[object Object]'));
					try {
						expect(noUndefined, 'Expected no undefined values in config').to.eq(-1);
					} catch (e) {
						throw new Error(
							`Found stringified undefined ${noUndefined + 1}:\n${annotatedLines.slice(Math.max(noUndefined - 4, 0), Math.min(annotatedLines.length, noUndefined + 5)).join('\n')}`,
						);
					}
					try {
						expect(noPromises, 'Expected no promises in config').to.eq(-1);
					} catch (e) {
						throw new Error(
							`Found stringified promise ${noUndefined + 1}:\n${annotatedLines.slice(Math.max(noUndefined - 4, 0), Math.min(annotatedLines.length, noUndefined + 5)).join('\n')}`,
						);
					}
					try {
						expect(noObjects, 'Expected no objects in config').to.eq(-1);
					} catch (e) {
						throw new Error(
							`Found stringified object ${noUndefined + 1}:\n${annotatedLines.slice(Math.max(noUndefined - 4, 0), Math.min(annotatedLines.length, noUndefined + 5)).join('\n')}`,
						);
					}
				});
				test('contain valid includes', async () => {
					const includes = splitRes.filter((l) => l.includes('[include '));
					const invalidIncludes = includes.filter((l) => !l.includes('[include RatOS'));
					const env = serverSchema.parse(process.env);
					includes
						.filter((l) => l.includes('[include RatOS/'))
						.forEach((l) => {
							try {
								expect(
									existsSync(path.join(env.RATOS_CONFIGURATION_PATH, l.split('[include RatOS/')[1].replace(']', ''))),
								).toBeTruthy();
							} catch (e) {
								const index = splitRes.findIndex((line) => line === l);
								throw new Error(
									`Found non existing include ${l}:\n${annotatedLines
										.slice(Math.max(index - 4, 0), Math.min(index + 5, splitRes.length))
										.join('\n')}`,
								);
							}
						});
				});
				test.runIf(res.fileName === 'printer.cfg').concurrent('contains position_min/max/endstop for x/y', async () => {
					const xSections: number[] = [];
					const ySections: number[] = [];
					splitRes.forEach((l, i) => {
						l.startsWith('[stepper_x]') && xSections.push(i);
						l.startsWith('[stepper_y]') && ySections.push(i);
					});
					[xSections, ySections].forEach((sections, i) => {
						const sectionName = ['x', 'y', 'z'][i];
						let hasMin = false;
						let hasMax = false;
						let hasEndstop = false;
						sections.forEach((i) => {
							const nextSection = splitRes.slice(i + 1).findIndex((l) => l.trim().startsWith('['));
							hasMin = splitRes.slice(i, i + nextSection).find((l) => l.includes('position_min:')) != null || hasMin;
							hasMax = splitRes.slice(i, i + nextSection).find((l) => l.includes('position_max:')) != null || hasMax;
							hasEndstop =
								splitRes.slice(i, i + nextSection).find((l) => l.includes('position_endstop:')) != null || hasEndstop;
						});
						try {
							expect(hasMin, `[stepper_${sectionName}] is missing position_min`).toBeTruthy();
							expect(hasMax, `[stepper_${sectionName}] is missing position_max`).toBeTruthy();
							expect(hasEndstop, `[stepper_${sectionName}] is missing position_endstop`).toBeTruthy();
						} catch (e) {
							console.log(annotatedLines.join('\n'));
							throw e;
						}
					});
				});
				test.runIf(res.fileName === 'printer.cfg').concurrent('contains no RatOS managed parameters', async () => {
					const offendingLines: { line: number; param: string }[] = [];
					const offendingStrings = ['nozzle_diameter', 'variable_hotend_type', 'variable_has_cht_nozzle'];
					splitRes.forEach((l, i) => {
						offendingStrings.forEach((s) => {
							if (l.startsWith(s)) {
								offendingLines.push({ line: i, param: s });
							}
						});
					});
					try {
						expect(offendingLines.length).toBe(0);
					} catch (e) {
						let errorMsg = '';
						for (const { line, param } of offendingLines) {
							errorMsg += `Illegal parameter "${param}" at line ${line + 1}:\n${annotatedLines.slice(Math.max(line - 4, 0), Math.min(line + 5, annotatedLines.length)).join('\n')}`;
						}
						throw new Error(errorMsg);
					}
				});
				test.concurrent('properly indents gcode blocks', async () => {
					const gcodeBlocks: number[] = [];
					splitRes.forEach((l, i) => l.includes('gcode:') && gcodeBlocks.push(i));
					for (const block of gcodeBlocks) {
						try {
							expect(
								splitRes[block + 1].startsWith('\t') ||
									splitRes[block + 1].startsWith('#\t') ||
									splitRes[block + 1].startsWith('  ') ||
									splitRes[block + 1].startsWith('#  '),
							).toBeTruthy();
						} catch (e) {
							throw new Error(
								`Failed to indent gcode block at line ${block + 1}:\n${annotatedLines.slice(Math.max(block - 4, 0), Math.min(block + 5, annotatedLines.length)).join('\n')}`,
							);
						}
					}
				});
			});
			test('can be compared', () => {
				compareSettings(serialized);
			});
		});
	});
	describe('mcu', async () => {
		test.concurrent('can compile firmware for controlboard and toolheads', async () => {
			const config = await loadSerializedConfig(path.join(__dirname, 'fixtures', 'idex-config.json'));
			const cbFirmware = await compileFirmware(config.controlboard, undefined, true);
			if (!cbFirmware) {
				throw new Error('Failed to compile controlboard firmware');
			}
			expect(
				cbFirmware
					.split('\n')
					.filter((l) => l.includes(`CONFIG_USB_SERIAL_NUMBER="${getBoardChipId(config.controlboard)}"`)).length,
			).toEqual(1);
			for (const toolhead of config.toolheads) {
				if (toolhead.toolboard == null) {
					throw new Error('Toolhead from test config has no toolboard');
				}
				const th = new ToolheadHelper(toolhead);
				const chipId = getBoardChipId(toolhead.toolboard, th);
				const thFirmware = await compileFirmware(toolhead.toolboard, th, true);
				if (!thFirmware) {
					throw new Error('Failed to compile controlboard firmware');
				}
				expect(thFirmware.split('\n').filter((l) => l.includes(`CONFIG_USB_SERIAL_NUMBER="${chipId}"`)).length).toEqual(
					1,
				);
			}
		});
	});
	describe('ini utils', async () => {
		describe('replaceOrAddIniSections', async () => {
			test('appends sections when none exist', async () => {
				const { replaceOrAddIniSections } = await import('@/server/helpers/file-operations');
				const content = '';
				const out = replaceOrAddIniSections(content, [
					{ section: 'alpha', body: 'a: 1' },
					{ section: 'beta', body: 'b: 2' },
				]);
				expect(out).toContain('[alpha]');
				expect(out).toContain('[beta]');
				// alpha should appear before beta
				expect(out.indexOf('[alpha]') < out.indexOf('[beta]')).toBeTruthy();
			});
			test('replaces first occurrence and removes duplicates, preserving header text', async () => {
				const { replaceOrAddIniSections } = await import('@/server/helpers/file-operations');
				const content = '[foo]\nold: 1\n\n[foo]\nold: 2\n';
				const out = replaceOrAddIniSections(content, [{ section: 'foo', body: 'new: 9' }]);
				// header of first match preserved
				expect(out).toContain('[foo]');
				// only one foo section remains
				const matches = out.match(/\[foo\b/g) || [];
				expect(matches.length).toEqual(1);
				// body replaced
				expect(out).toContain('new: 9');
				// old bodies gone
				expect(out).not.toContain('old: 1');
				expect(out).not.toContain('old: 2');
			});
			test('normalizes section name whitespace for matching', async () => {
				const { replaceOrAddIniSections } = await import('@/server/helpers/file-operations');
				const content = '[doo  dah]\nold: 1\n\n[doo   dah ]\nold: 2\n';
				const out = replaceOrAddIniSections(content, [{ section: 'doo dah', body: 'new: 9' }]);
				// header of first match preserved
				expect(out).toContain('[doo  dah]');
				// only one doo dah section remains
				const matches = out.match(/\[doo\s+dah\b/g) || [];
				expect(matches.length).toEqual(1);
				// body replaced
				expect(out).toContain('new: 9');
				// old bodies gone
				expect(out).not.toContain('old: 1');
				expect(out).not.toContain('old: 2');
			});
			test('multiple updates: replace existing and append missing in order', async () => {
				const { replaceOrAddIniSections } = await import('@/server/helpers/file-operations');
				const content = '[a]\nval: 1\n\n[other]\nfoo: bar\n';
				const out = replaceOrAddIniSections(content, [
					{ section: 'a', body: 'val: replaced' },
					{ section: 'b', body: 'bval: appended' },
				]);
				// a should be replaced
				expect(out).toContain('[a]');
				expect(out).toContain('val: replaced');
				// b appended at EOF after existing sections
				expect(out.indexOf('[a]') < out.indexOf('[b]')).toBeTruthy();
			});
			test('preserves CRLF style when input contains CRLF', async () => {
				const { replaceOrAddIniSections } = await import('@/server/helpers/file-operations');
				const content = 'preline\r\n[sec]\r\nval:1\r\n';
				const out = replaceOrAddIniSections(content, [{ section: 'sec', body: 'val:2' }]);
				// should contain CRLF sequences
				expect(out.includes('\r\n')).toBeTruthy();
				// and the updated value
				expect(out).toContain('val:2');
			});
			test('preserves blank line between adjacent replaced sections', async () => {
				const { replaceOrAddIniSections } = await import('@/server/helpers/file-operations');
				const content = '[a]\nval: 1\n\n[other]\nfoo: bar\n';
				const out = replaceOrAddIniSections(content, [
					{
						section: 'a',
						body: 'val: replaced\n',
					},
					{
						section: 'other',
						body: 'foo: replaced\nbar: baz\n',
					},
				]);

				expect(out).toContain('val: replaced\n\n[other]');
			});
			test('preserves trailing comments after retained values (including surrounding whitespace) ', async () => {
				const { replaceOrAddIniSections } = await import('@/server/helpers/file-operations');
				const content = '[a]\nx: 1    # comment  \ny: 2   # blah\n\n[other]\nq: 123\n';
				const out = replaceOrAddIniSections(content, [
					{
						section: 'a',
						body: 'x: 42\n',
					},
				]);

				expect(out).toContain('x: 42    # comment  \n\n[other]');
			});
			test('multiple updates for same name: last update wins', async () => {
				const { replaceOrAddIniSections } = await import('@/server/helpers/file-operations');
				const content = '';
				const out = replaceOrAddIniSections(content, [
					{ section: 'dup', body: 'v: old' },
					{ section: 'dup', body: 'v: new' },
				]);
				// only new body should be present
				expect(out).toContain('v: new');
				expect(out).not.toContain('v: old');
			});
			test('retains existing comments on unreplaced sections', async () => {
				const { replaceOrAddIniSections } = await import('@/server/helpers/file-operations');
				const content = '# Start comment\n[section1]\nval: 1\n\n# Another comment\n[section2]\nval: 2\n';
				const out = replaceOrAddIniSections(content, [{ section: 'section1', body: 'v: new\n' }]);
				// new body should be present
				expect(out).toContain('v: new');
				// comment before section2 should be preserved
				expect(out).toContain('# Another comment\n[section2]');
			});
			test('retains trailing comments after replaced sections at end of content', async () => {
				const { replaceOrAddIniSections } = await import('@/server/helpers/file-operations');
				const content = '# Start comment\n[section1]\nval: 1\n\n# Another comment\n[section2]\nval: 2\n\n# End comment';
				const out = replaceOrAddIniSections(content, [{ section: 'section2', body: 'v: new\n' }]);
				// new body should be present
				expect(out).toContain('v: new');
				// comment after section2 should be preserved
				expect(out).toContain('v: new\n\n# End comment');
			});
			test('retains trailing comments after unreplaced sections at end of content', async () => {
				const { replaceOrAddIniSections } = await import('@/server/helpers/file-operations');
				const content = '# Start comment\n[section1]\nval: 1\n\n# Another comment\n[section2]\nval: 2\n\n# End comment';
				const out = replaceOrAddIniSections(content, [{ section: 'section1', body: 'v: new\n' }]);
				// new body should be present
				expect(out).toContain('v: new');
				// comment after section 2 should be preserved
				expect(out).toContain('val: 2\n\n# End comment');
			});
			test('idempotent: replacing section with identical content returns identical output', async () => {
				const { replaceOrAddIniSections } = await import('@/server/helpers/file-operations');
				const content = '[section1]\nval: 1\nkey: 2\n\n[section2]\nval: 3\n';
				const out = replaceOrAddIniSections(content, [{ section: 'section1', body: 'val: 1\nkey: 2\n\n' }]);
				expect(out).toEqual(content);
			});
			test('idempotent: replacing multiple sections with identical content returns identical output', async () => {
				const { replaceOrAddIniSections } = await import('@/server/helpers/file-operations');
				const content = '[section1]\nval: 1\n\n[section2]\nval: 2\nkey: 3\n\n[section3]\nval: 4\n';
				const out = replaceOrAddIniSections(content, [
					{ section: 'section1', body: 'val: 1\n\n' },
					{ section: 'section2', body: 'val: 2\nkey: 3\n\n' },
					{ section: 'section3', body: 'val: 4\n' },
				]);
				expect(out).toEqual(content);
			});
			test('idempotent: works with trailing whitespace and comments between sections', async () => {
				const { replaceOrAddIniSections } = await import('@/server/helpers/file-operations');
				const content = '[section1]\nval: 1\n\n# Comment\n[section2]\nval: 2\n';
				const out = replaceOrAddIniSections(content, [
					{ section: 'section1', body: 'val: 1\n\n# Comment\n' },
					{ section: 'section2', body: 'val: 2\n' },
				]);
				expect(out).toEqual(content);
			});
			test('idempotent: preserves prelude and EOF formatting', async () => {
				const { replaceOrAddIniSections } = await import('@/server/helpers/file-operations');
				const content = '# Header comment\n\n[section1]\nval: 1\n\n[section2]\nval: 2\n';
				const out = replaceOrAddIniSections(content, [
					{ section: 'section1', body: 'val: 1\n' },
					{ section: 'section2', body: 'val: 2\n' },
				]);
				expect(out).toEqual(content);
			});
			test('idempotent: works with CRLF line endings', async () => {
				const { replaceOrAddIniSections } = await import('@/server/helpers/file-operations');
				const content = '[section1]\r\nval: 1\r\n\r\n[section2]\r\nval: 2\r\n';
				const out = replaceOrAddIniSections(content, [
					{ section: 'section1', body: 'val: 1\n' },
					{ section: 'section2', body: 'val: 2\n' },
				]);
				expect(out).toEqual(content);
			});
			test('changing one section does not affect others', async () => {
				const { replaceOrAddIniSections } = await import('@/server/helpers/file-operations');
				const content = '[section1]\nval: 1\n\n[section2]\nval: 2\nkey: 3\n\n[section3]\nval: 4\n';
				const out = replaceOrAddIniSections(content, [{ section: 'section2', body: 'val: changed\n' }]);
				expect(out).toContain('[section1]\nval: 1\n\n');
				expect(out).toContain('[section2]\nval: changed\n');
				expect(out).toContain('[section3]\nval: 4\n');
			});
		});
	});
});
