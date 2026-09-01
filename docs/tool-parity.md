# Tool parity, legacy dialect against EN11F

Two drivers serve Siglent oscilloscopes. [`src/devices/oscilloscope/`](../src/devices/oscilloscope/) implements
PG01-E02C for the older families and [`src/devices/oscilloscope-scpi/`](../src/devices/oscilloscope-scpi/) implements
the EN11F colon-tree dialect for the newer ones. The rule the newer driver was built to is that **tool names and
result shapes match the legacy driver wherever the operation is equivalent**, so an MCP client stays model-agnostic,
and that every divergence is written down. This page is that list.

Nothing on this page has been checked against an instrument. It compares two code bases, not two scopes.

## Legacy tools with no EN11F counterpart

36 tools. Most are folded into a tool that already exists rather than dropped.

| Legacy tool | Why the EN11F driver has none |
| --- | --- |
| `mark_operation_complete` | EN11F documents `*OPC` as a query alone (PDF p. 30), so there is no command form to send. `wait_until_complete` owns the query. |
| `get_communication_header`, `configure_communication_header` | EN11F has no `CHDR` concept. Answers are plain values with no mnemonic prefix, so there is nothing to read or set. |
| `get_network_address` | Renamed `get_lan_configuration`, which reports the address, netmask, gateway, MAC, DHCP type and VNC port instead of the address alone. |
| `change_scope_ip` | Renamed `configure_lan`, which writes the same three values plus the LAN type and the VNC port. Still destructive and still behind an explicit confirmation. |
| `read_status_events` | EN11F documents no status event register. There is no `INR?` in the guide. |
| `configure_acquisition_display` | Its two settings are `:ACQuire:INTerpolation` and `:ACQuire:MODE` in this dialect, both owned by `configure_acquisition`. |
| `configure_trigger_type`, `configure_pattern_trigger`, `configure_trigger_window`, `get_i2c_trigger`, `configure_i2c_trigger`, `get_spi_trigger`, `configure_spi_trigger`, `get_uart_trigger`, `configure_uart_trigger`, `get_can_trigger`, `configure_can_trigger`, `get_lin_trigger`, `configure_lin_trigger` | 13 tools, replaced by the single `configure_trigger` and `get_trigger`. The EN11F trigger tree is addressed by type (`:TRIGger:<TYPE>:<parameter>`), not by source as the legacy `TRSE` line is, and `:TRIGger:TYPE` takes 24 types. One tool per type would repeat the same shared leaves 24 times, and `get_trigger` reads the type first and then queries only that subsystem. |
| `configure_i2c_decode`, `configure_spi_decode`, `configure_uart_decode`, `configure_can_decode`, `configure_lin_decode` | Replaced by the single `configure_decode`, for the same reason. The EN11F decode tree is `:DECode:BUS<n>:<protocol>:<parameter>` over 13 protocols, and the protocol selects the leaves. |
| `read_frequency_counter` | Split in two, because EN11F puts the two halves in different subsystems. The counted value is `:TRIGger:FREQuency?`, which `get_trigger` reports. The `:COUNter` subsystem is settings and resets only, owned by `get_counter`, `configure_counter` and `reset_counter`. EN11F documents no query for the counter's own reading. |
| `get_pass_fail`, `configure_pass_fail`, `get_pass_fail_mask`, `configure_pass_fail_mask`, `reset_pass_fail_statistics` | The subsystem is named `:MTESt` in EN11F and is a larger surface. It is owned by `get_mask_test`, `configure_mask_test`, `read_mask_test_result`, `reset_mask_test`, `create_mask` and `load_mask`. |
| `capture_panel_setup`, `restore_panel_setup` | EN11F documents no panel-setup blob transfer. `:SAVE:SETup` and `:RECall:SETup` name an internal slot or a file on the scope, which `save_panel_setup` and `recall_panel_setup` own, so a setup cannot be carried through the client. |
| `close_reference` | `configure_reference` takes the display state, so closing a reference is `{location, display: false}`. |
| `get_obsolete_settings`, `send_obsolete_command` | The obsolete command chapter belongs to PG01-E02C. EN11F documents no obsolete forms. |

## Shared tools that differ

41 of the 49 shared names take a different input schema or carry a different annotation, and each one is a row below.
The other 8 take exactly the same input: `identify`, `wait_until_complete`, `reset_scope`, `autoset_scope`,
`get_system_settings`, `get_timebase`, `get_display` and `get_measurement_gate`. Their answers still follow the value
rules at the end of this page, and a read-back reports the subsystem this dialect documents rather than the legacy one
field for field.

| Tool | Divergence |
| --- | --- |
| `calibrate_scope` | The input fields and limits match. The EN11F timeout description states that each wait is also bounded by the server response ceiling. |
| `scpi_query`, `scpi_command` | The input shapes match, but their examples use the command spelling of their respective dialect. |
| `configure_system_settings` | EN11F adds the clock source, date, time, language, power-on line state, remote lock, touch screen and menu switch to the buzzer, screensaver and education-mode flags. |
| `get_channel`, `configure_channel` | `source` is the input name and `channel` an accepted alias. Adds the shared vertical reference, the input impedance, the label and its text, and the separate visibility of a switched-on channel. |
| `get_acquisition` | Drops `source`. EN11F reports one sample rate and one point count for the acquisition, not one per trace. |
| `configure_acquisition` | Loses `time_per_div` and `trigger_delay` to `configure_timebase`, and `trigger_mode` and `action` to `configure_trigger_mode`. Gains the ADC resolution, capture rate, interpolation, sequence mode and count, acquisition type with average count and enhanced bits, memory management and sample rate. |
| `configure_timebase` | Gains the horizontal reference strategy, the reference position in percent and the zoom window switch. |
| `get_trigger` | Drops `source`. It reads `:TRIGger:TYPE?` first and reports the parameters of that type. |
| `configure_trigger` | One type-addressed tool for all 24 trigger types, so it takes `type` and the leaves of that type rather than the legacy edge-only set. |
| `get_cursors`, `configure_cursors`, `measure_cursors` | EN11F names two sources and four positions (`x1`, `x2`, `y1`, `y2`) instead of a positions map, splits the legacy `type` into `mode` and `manual_type`, and adds the tag style and the measure item. `measure_cursors` reads the deltas of the pair in force and takes no input. |
| `get_decode`, `configure_decode` | Both gain `bus`. EN11F addresses two buses, and `configure_decode` carries the parameters of all 13 protocols. |
| `configure_digital` | Adds the active line set, the per-line labels, the display height and position, the skew and the digital bus definitions. |
| `get_digital` | The `lines` input has the same values and default. EN11F returns the active channel, geometry, labels, sample information and bus definitions in addition to visibility and thresholds. |
| `configure_display` | The legacy `menu` flag becomes `menu_style` and `menu_hide`. Adds axis labels and mode, backlight, color grading and the handheld information-bar transparence. |
| `get_history` | Drops `timeout_ms`. |
| `configure_history` | Adds the list interval, the list type and the play switch. |
| `get_math`, `configure_math`, `get_fft`, `configure_fft` | All four gain `function`. EN11F addresses F1 to F4 rather than one math trace, and the FFT is a mode of a function rather than a subsystem of its own. |
| `configure_measurement_gate` | Legacy gate positions are quantities with optional time units and cannot be read back. EN11F positions are numbers of seconds and are read back. |
| `measure_delay` | Gains `item`, the advanced slot P1 to P12 the delay measurement is installed in. |
| `measure`, `read_measurement` | `source` replaces `channel`, which stays as an alias, and `parameters` takes a list. The result is a `values` array of `{parameter, value}` under one `source`, not a flat `channel` and `value` pair. |
| `list_measurements` | `slot` becomes `item`. EN11F addresses P1 to P12 and reads `:MEASure:ADVanced:LINenumber?` to learn how many exist. |
| `get_measurement_statistics` | `channel` and `parameter` become `item` and `statistic`. Statistics belong to an advanced item, not to a channel and parameter pair. |
| `configure_measurement_statistics` | Annotated destructive rather than mutating, because `reset` discards accumulated statistics with no query to read them back first. Adds the histogram, the maximum count and the AIM limit. |
| `clear_measurements` | Gains `items`, so one slot can be cleared instead of all of them. |
| `capture_screenshot` | Gains `inverted`, which EN11F documents as an argument of `:PRINt?`. |
| `save_panel_setup`, `recall_panel_setup` | The legacy `usb` flag becomes `file`, a quoted path with one of the four documented drive prefixes. `save_panel_setup` adds `default_setup` and `recall_panel_setup` adds `factory`, which are `:SAVE:DEFault` and `:RECall:FDEFault`. |
| `get_reference`, `configure_reference` | Both gain `location`, since EN11F holds four references (A to D). `source` and `save` become `save_source` and `recall_file`, and a reference carries a label. |
| `get_waveform` | `sparsing` becomes `interval` and the sequence inputs `frame` and `frame_start` are new. The result is reshaped by the descriptor: see the value rules below. |
| `get_waveform_generator` | Drops `waveforms`. EN11F reads the current wave in one line rather than a catalogue. |
| `configure_waveform_generator` | The legacy composite `waveform` object becomes flat typed parameters (type, frequency, period, amplitude, offset, symmetry, duty, deviation, mean, width), and the tool also owns the sync output and the over-voltage protection. `confirm_output_enable` is kept. |

## EN11F tools with no legacy counterpart

43 tools. Every one covers a subsystem PG01-E02C does not document.

| EN11F tool | What it covers |
| --- | --- |
| `get_data_format`, `configure_data_format` | `:FORMat:DATA`, the precision and digit count of returned numbers. |
| `clear_sweeps` | `:ACQuire:CSWeep`, which discards accumulated sweeps, statistics and persistence. |
| `configure_trigger_mode` | `:TRIGger:MODE`, `:TRIGger:RUN` and `:TRIGger:STOP`. Run and stop live on the trigger subsystem in this dialect, not on the acquisition subsystem as the legacy `action` input did. |
| `get_search`, `configure_search`, `read_search_events`, `copy_search_settings` | The `:SEARch` subsystem, which marks matching events in the acquired record. PG01-E02C has none. |
| `autoset_fft`, `reset_fft`, `read_fft_peaks` | `:FUNCtion<x>:FFT:AUToset`, `:FFT:RESET` and the peak table `:FFT:SEARch:RESult?`. |
| `get_measurement_setup`, `configure_measurement_setup`, `configure_advanced_measurement` | The simple and advanced measurement modes, the amplitude strategy and the threshold set, and the 12 addressed advanced items. |
| `copy_decode_settings`, `read_decode_result` | `:DECode:BUS<n>:COPY` between decode and trigger, and the decoded frame list. |
| `clear_display` | `:DISPlay:CLEar`. |
| `get_counter`, `configure_counter`, `reset_counter` | The `:COUNter` subsystem: mode, source, level, statistics and the totalizer with its gate. |
| `get_mask_test`, `configure_mask_test`, `read_mask_test_result`, `reset_mask_test`, `create_mask`, `load_mask` | The `:MTESt` subsystem, EN11F's larger successor to legacy pass/fail. |
| `get_dvm_reading`, `configure_dvm` | The `:DVM` subsystem. |
| `read_meter`, `configure_meter`, `measure_meter` | The `METEr` group, the handheld multimeter of the SHS800X and SHS1000X. Refused on any other model. |
| `get_memory`, `configure_memory`, `import_memory` | The `:MEMory<m>` internal waveform memories. |
| `erase_internal_storage` | `:RECall:SERase`, which deletes every user file on the scope. |
| `save_waveform_file` | `:SAVE:CSV`, `:BINary`, `:MATLab` and `:REFerence`. |
| `save_screenshot` | `:SAVE:IMAGe`, which writes the image to the scope storage instead of returning it. |
| `get_lan_configuration`, `configure_lan` | The renamed successors of `get_network_address` and `change_scope_ip`, listed here because the names are new. |
| `get_network_storage`, `configure_network_storage` | `:SYSTem:NSTorage`, the network drive mount. |
| `reboot_scope`, `shutdown_scope` | `:SYSTem:REBoot` and `:SYSTem:SHUTdown`. |

## Value rules that differ everywhere

These apply across the whole EN11F surface, so they are stated once rather than repeated per tool.

- **Times, voltages and rates are numbers, not unit strings.** The legacy driver takes `-3us` and `500mV` and returns
  a quantity parsed from a unit string. EN11F documents NR3 throughout, so an input is a plain number of seconds,
  volts or samples per second and travels as `-3.00E-06`. A returned number carries no unit of its own.
- **Coupling is split.** The legacy `coupling` combines the coupling and the input impedance (`A1M`, `A50`, `D1M`,
  `D50`, `GND`). EN11F has `:CHANnel<n>:COUPling` with `DC`, `AC` and `GND` and a separate `:CHANnel<n>:IMPedance`,
  so `configure_channel` takes `coupling` and `impedance`.
- **`bandwidth_limit` is an enum, not a boolean.** EN11F takes `FULL`, `20M` or `200M` where the legacy `BWL` takes
  on or off.
- **`measure` and `read_measurement` return a `values` array.** One `source` and a list of `{parameter, value}`
  replaces the legacy flat `channel` and `value`, because a request can name several parameters at once.
- **`get_waveform` is descriptor driven.** Scaling, timing and frame counts come from the `:WAVeform:PREamble?`
  block, which the result carries under `preamble`. `scaling.volts_per_division` is a number where the legacy result
  holds a parsed quantity, `timing.time_per_div` replaces `timing.timebase`, and `waveform.decimation` states how
  many acquired points one returned point stands for where the legacy result carries a `truncated` boolean. The
  legacy `block` and `kind` keys are gone and `frames` is new. `scaling.sample_bits` is the width of the transferred
  sample container, which the descriptor reports as 16 on a 12-bit scope, and `scaling.adc_resolution_bits` carries
  the known converter resolution where the model states one.
- **A tool that refuses is still listed.** Neither driver hides a tool by model. A capability the identity does not
  report is warned about or refused when the call is made, so `tools/list` is the same on every model of a dialect.
