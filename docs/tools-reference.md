# Tool reference

Generated from the registered tool definitions by `npm run coverage`. Do not edit by hand. The descriptions and
input fields are the same metadata returned by MCP `tools/list` and the authenticated root catalogue.

Safety describes the MCP annotation. Destructive tools can replace data, reset accumulated results, interrupt the
instrument, change connectivity, or drive an output. Required `confirm_*` inputs are call-level safeguards and are
listed with the affected tool. An available tool can still report unknown option support or refuse an unsupported
model. Read [hardware verification](hardware-verification.md) before relying on instrument behavior.

The two oscilloscope sections are separate because their command dialects, accepted inputs, and result shapes can
differ even when a tool name is shared. See [tool parity](tool-parity.md) for those differences.

## Legacy PG01-E02C oscilloscope

<a id="tool-legacy-identify"></a>
### `identify`

Identify the connected oscilloscope. Returns the manufacturer, model, serial number, firmware, derived family, command dialect, and channel count.

- Safety: Read-only
- Inputs: none

<a id="tool-legacy-wait-until-complete"></a>
### `wait_until_complete`

Wait until all pending scope operations have finished. Blocks the connection until the scope answers or the timeout expires. A timeout closes the connection.

- Safety: Read-only
- Inputs:
  - `timeout_ms` (optional): Response timeout in milliseconds. Minimum 100. Maximum 120000.

<a id="tool-legacy-mark-operation-complete"></a>
### `mark_operation_complete`

Set the operation-complete bit in the Standard Event Status Register after pending operations finish. The command has no query form. Use wait_until_complete when the caller must wait for completion.

- Safety: Setup change
- Inputs: none

<a id="tool-legacy-reset-scope"></a>
### `reset_scope`

Reset the scope to factory defaults, wait for completion, restore the communication header, and identify the scope again. Requires `confirm_reset: true`. Nothing is sent otherwise.

- Safety: Destructive
- Inputs:
  - `confirm_reset` (required): Explicit acknowledgement that all scope settings are discarded. Required value `true`.
  - `timeout_ms` (optional): Completion timeout in milliseconds, default 30000. Minimum 100. Maximum 120000.

<a id="tool-legacy-get-communication-header"></a>
### `get_communication_header`

Read the response header mode. Off omits headers and units. Short and Long prefix responses with the short or long command name. The server sets Off when connecting.

- Safety: Read-only
- Inputs: none

<a id="tool-legacy-configure-communication-header"></a>
### `configure_communication_header`

Set the response header mode. Typed tools support every mode. Raw SCPI query responses preserve the header. The selected mode is restored after reconnecting.

- Safety: Setup change
- Inputs:
  - `mode` (required): Accepted values `"OFF"`, `"SHORT"`, `"LONG"`.

<a id="tool-legacy-calibrate-scope"></a>
### `calibrate_scope`

Run the user self-calibration. The scope stops acquisition, disables the front-panel keys, and holds the connection until calibration finishes. Disconnect every input first. Requires `confirm_inputs_disconnected: true`. Nothing is sent otherwise. The default timeout is 300 seconds, bounded by the server response ceiling of 180000 ms by default, so a longer calibration needs --max-response-timeout raised. A timeout closes the connection while the scope continues calibrating.

- Safety: Destructive
- Inputs:
  - `confirm_inputs_disconnected` (required): Explicit acknowledgement that every input is disconnected and the scope may go out of service. Required value `true`.
  - `timeout_ms` (optional): Calibration timeout in milliseconds, default 300000. Minimum 10000. Maximum 900000.

<a id="tool-legacy-get-network-address"></a>
### `get_network_address`

Read the IPv4 address of the scope's network interface. Netmask, gateway, and DHCP state are not available. An invalid address is returned only as raw text.

- Safety: Read-only
- Inputs: none

<a id="tool-legacy-change-scope-ip"></a>
### `change_scope_ip`

Change the scope's IPv4 address. This disconnects the server from the scope. Calls fail until the server is restarted with the new address. DHCP must be disabled, but its state cannot be checked. Requires `confirm_disconnect: true`. Nothing is sent when the address is unchanged.

- Safety: Destructive
- Inputs:
  - `address` (required): IPv4 address for the scope's network interface, e.g. '10.11.0.230'.
  - `confirm_disconnect` (required): Explicit acknowledgement that this connection dies and the scope answers only at the new address. Required value `true`.

<a id="tool-legacy-scpi-query"></a>
### `scpi_query`

Send a raw SCPI query and return its text response. Use this only when no typed tool is available. Some queries have side effects. Responses follow the communication header mode. The default Off mode returns values only.

- Safety: Destructive
- Inputs:
  - `command` (required): SCPI query, for example 'C1:VDIV?'. Minimum length 1. Maximum length 256.
  - `timeout_ms` (optional): Response timeout in milliseconds. Minimum 100. Maximum 120000.

<a id="tool-legacy-scpi-command"></a>
### `scpi_command`

Send a raw SCPI command without reading a response. Use this only when no typed tool is available.

- Safety: Destructive
- Inputs:
  - `command` (required): SCPI command, for example 'C1:VDIV 500mV'. Minimum length 1. Maximum length 256.

<a id="tool-legacy-read-status-events"></a>
### `read_status_events`

Read and decode pending scope status events. Reading clears the event register for every reader. A second call returns zero until new events occur. Known events are decoded and unknown bits are preserved.

- Safety: Setup change
- Inputs: none

<a id="tool-legacy-get-system-settings"></a>
### `get_system_settings`

Read the buzzer, screensaver idle time, and education-mode function locks. Education fields report whether each function is usable. False means locked.

- Safety: Read-only
- Inputs: none

<a id="tool-legacy-configure-system-settings"></a>
### `configure_system_settings`

Configure the buzzer, screensaver idle time, and education-mode function locks. Each education field controls whether the function remains usable. Set it to false to lock the function.

- Safety: Setup change
- Inputs:
  - `buzzer` (optional): sound the buzzer.
  - `screensaver` (optional): Idle time after which the monitor is blanked. The scope remains fully functional. Accepted values `"OFF"`, `"1MIN"`, `"5MIN"`, `"10MIN"`, `"30MIN"`, `"60MIN"`.
  - `autosetup_enabled` (optional): Leave Auto Setup usable. Disable to lock it.
  - `measure_enabled` (optional): Leave measurements usable. Disable to lock them.
  - `cursors_enabled` (optional): Leave cursors usable. Disable to lock them.

<a id="tool-legacy-get-channel"></a>
### `get_channel`

Read an analog channel configuration, including volts per division, offset, coupling, bandwidth limit, visibility, probe attenuation, unit, skew, and inversion.

- Safety: Read-only
- Inputs:
  - `channel` (required): Analog channel. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`.

<a id="tool-legacy-configure-channel"></a>
### `configure_channel`

Configure an analog channel. Only the provided settings change. Probe attenuation is applied before scale and offset.

- Safety: Setup change
- Inputs:
  - `channel` (required): Analog channel. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`.
  - `probe_attenuation` (optional): probe attenuation factor, 0.1 to 10000. 16 accepted values.
  - `volts_per_div` (optional): volts per division, 500uV to 10V, e.g. '500mV' or '1V'.
  - `offset` (optional): Vertical offset, for example '-500mV'. The allowed range depends on volts per division.
  - `coupling` (optional): A1M=AC 1MOhm, A50=AC 50Ohm, D1M=DC 1MOhm, D50=DC 50Ohm, GND. Accepted values `"A1M"`, `"A50"`, `"D1M"`, `"D50"`, `"GND"`.
  - `skew` (optional): channel-to-channel deskew, -100NS to 100NS, e.g. '3NS'.
  - `unit` (optional): measurement unit of the probe. Accepted values `"V"`, `"A"`.
  - `inverted` (optional): invert the trace.
  - `trace` (optional): show or hide the trace.
  - `bandwidth_limit` (optional): Enable or disable the 20 MHz bandwidth limit.

<a id="tool-legacy-autoset-scope"></a>
### `autoset_scope`

Automatically adjust the vertical scale, timebase, and trigger to display the input signals. Waits for completion and returns the acquisition state and every visible channel. Requires `confirm_autoset: true`. Nothing is sent otherwise.

- Safety: Destructive
- Inputs:
  - `confirm_autoset` (required): Explicit acknowledgement that channel, timebase and trigger settings change. Required value `true`.
  - `timeout_ms` (optional): Completion timeout in milliseconds, default 15000. Minimum 100. Maximum 120000.

<a id="tool-legacy-get-acquisition"></a>
### `get_acquisition`

Read the acquisition state, including run status, sample rate, time per division, trigger delay, trigger mode, acquisition mode, average count, memory depth, interpolation, and XY display. With a source, also read the acquired point count of an analog channel or the digital sample rate. Digital acquisition requires an SDS1000X-E with the MSO option.

- Safety: Read-only
- Inputs:
  - `source` (optional): Analog channel for its point count, or digital. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`, `"digital"`.

<a id="tool-legacy-configure-acquisition"></a>
### `configure_acquisition`

Set the time per division, trigger delay, trigger mode, acquisition mode, average count, and memory depth. Optionally start or stop acquisition. Fails when the scope does not apply the requested acquisition mode, average count, or memory depth. Supported values vary by model and interleave mode.

- Safety: Setup change
- Inputs:
  - `time_per_div` (optional): Time per division, for example '1US'. The range varies by model. 34 accepted values.
  - `trigger_delay` (optional): Trigger delay with a unit, for example '4.8US'. Negative subsecond values are sent as provided because model behavior varies.
  - `trigger_mode` (optional): AUTO, NORM, SINGLE or STOP. Accepted values `"AUTO"`, `"NORM"`, `"SINGLE"`, `"STOP"`.
  - `mode` (optional): Acquisition mode. High Resolution requires an SPO model. Accepted values `"SAMPLING"`, `"PEAK_DETECT"`, `"AVERAGE"`, `"HIGH_RES"`.
  - `average_count` (optional): Number of samples to average. Set mode to Average when providing both values. Accepted values `4`, `16`, `32`, `64`, `128`, `256`, `512`, `1024`.
  - `memory_depth` (optional): Memory depth. Available depths depend on the active channels and interleave mode. Accepted values `"7K"`, `"70K"`, `"700K"`, `"7M"`, `"14K"`, `"140K"`, `"1.4M"`, `"14M"`.
  - `action` (optional): Start or stop acquisition. Accepted values `"run"`, `"stop"`.

<a id="tool-legacy-configure-acquisition-display"></a>
### `configure_acquisition_display`

Set waveform interpolation and XY display mode.

- Safety: Setup change
- Inputs:
  - `interpolation` (optional): Accepted values `"sine"`, `"linear"`.
  - `xy_display` (optional): Plot channels against each other instead of time.

<a id="tool-legacy-get-timebase"></a>
### `get_timebase`

Read the main time per division, trigger delay, zoomed window scale, and zoomed window position. SDS1000X-E returns zoom values as times. Other families return factors. Parsed and raw values are included.

- Safety: Read-only
- Inputs: none

<a id="tool-legacy-configure-timebase"></a>
### `configure_timebase`

Configure the main time per division, trigger delay, zoomed window scale, and zoomed window position. SDS1000X-E takes zoom values as times. Other families take factors. Unknown models accept the provided format unchecked. The zoom scale cannot exceed the main time per division. The scope adjusts positions outside the main sweep.

- Safety: Setup change
- Inputs:
  - `time_per_div` (optional): Time per division, for example '1US'. The range varies by model. 34 accepted values.
  - `trigger_delay` (optional): Trigger delay with a unit, for example '4.8US'. Negative subsecond values are sent as provided because model behavior varies.
  - `zoom_scale` (optional): Zoomed window scale. Use a time value from 1NS to the current time per division on SDS1000X-E, or a factor from 1 to 2000000 on other families.
  - `zoom_position` (optional): Zoomed window position. Use a time value on SDS1000X-E or a factor of the zoomed timebase on other families. A value without a unit means seconds. The scope adjusts positions outside the main sweep.

<a id="tool-legacy-get-trigger"></a>
### `get_trigger`

Read the trigger state for one source, including sweep mode, window height, trigger type and criteria, pattern, coupling, levels, and slope. Lower level is available only for analog channels. Single acquisition reports Stop after triggering.

- Safety: Read-only
- Inputs:
  - `source` (required): Trigger source C1-C4, EX, or EX5. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`, `"EX"`, `"EX5"`.

<a id="tool-legacy-configure-trigger"></a>
### `configure_trigger`

Configure coupling, level, lower level, and slope for one trigger source, or center the level on the source waveform. Lower level requires a dual-level trigger and an analog source. Window slope requires an Edge trigger. Centering applies only to the active trigger source and has no effect on dual-level triggers. The scope may adjust levels outside the source range.

- Safety: Setup change
- Inputs:
  - `source` (required): Trigger source C1-C4, EX, or EX5. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`, `"EX"`, `"EX5"`.
  - `coupling` (optional): AC blocks the DC component, DC passes both, HFREJ low-passes, LFREJ high-passes the trigger path. Accepted values `"AC"`, `"DC"`, `"HFREJ"`, `"LFREJ"`.
  - `level` (optional): Trigger level, for example '52mV'. The range is -4.5 to 4.5 divisions of the source and -3 to 3 divisions for EX or EX5. On a dual-level type, this is the higher level. The scope adjusts out-of-range values and returns a warning.
  - `level_low` (optional): lower trigger level of a dual-level trigger type (SLEW, RUNT), analog channels only, -4.5 to 4.5 divisions.
  - `slope` (optional): Positive means rising. Negative means falling. Window means alternating and is available only for Edge triggers. Accepted values `"POS"`, `"NEG"`, `"WINDOW"`.
  - `center_level` (optional): Set the trigger level to the center of the source waveform.

<a id="tool-legacy-configure-trigger-type"></a>
### `configure_trigger_type`

Select the trigger type, source, and criteria. Edge supports hold times from 80ns to 1.5s. Slew, Glitch, Interval, Runt, and Dropout support 2ns to 4.2s. TV supports a standard, synchronization mode, line, and field. Serial requires SDS1000X-E. Only fields for the selected type are accepted. Select Pattern on the scope before using configure_pattern_trigger.

- Safety: Setup change
- Inputs:
  - `type` (required): Trigger type. GLIT means Glitch, INTV means Interval, and DROP means Dropout. Accepted values `"EDGE"`, `"SLEW"`, `"GLIT"`, `"INTV"`, `"RUNT"`, `"DROP"`, `"TV"`, `"SERIAL"`.
  - `source` (optional): C1-C4 for any trigger type. Line, EX, and EX5 are available only for Edge triggers. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`, `"LINE"`, `"EX"`, `"EX5"`.
  - `hold_type` (optional): hold/limit type: TI (time) and OFF for EDGE, TI for DROP, PS/PL/P2/P1 (pulse smaller, larger, in range, out of range) for GLIT and RUNT, IS/IL/I2/I1 (interval smaller, larger, in range, out of range) for SLEW and INTV. Accepted values `"TI"`, `"OFF"`, `"PS"`, `"PL"`, `"P2"`, `"P1"`, `"IS"`, `"IL"`, `"I2"`, `"I1"`.
  - `hold_value` (optional): Hold or limit time. For ranged types, this is the lower bound. Edge supports 80ns to 1.5s. Other types support 2ns to 4.2s.
  - `hold_value2` (optional): upper bound of the in-range and out-of-range hold types P2, P1, I2 and I1.
  - `standard` (optional): TV standard. Accepted values `"NTSC"`, `"PAL"`, `"720P/50"`, `"720P/60"`, `"1080P/50"`, `"1080P/60"`, `"1080I/50"`, `"1080I/60"`, `"CUST"`.
  - `sync` (optional): TV synchronization. Any triggers on any line. Select triggers on the requested line. Support is unverified on hardware. Accepted values `"ANY"`, `"SELECT"`.
  - `line` (optional): TV line to trigger on. The maximum depends on the standard and field. Minimum 1. Maximum 9007199254740991.
  - `field` (optional): TV field. Use 1 or 2 for interlaced standards, or 1 to 8 for Custom. Minimum 1. Maximum 8.

<a id="tool-legacy-configure-pattern-trigger"></a>
### `configure_pattern_trigger`

Set channel statuses and the boolean condition for the pattern trigger. Each channel may be ignored, below its trigger level, or above it. At least one channel must participate and must be enabled. Select Pattern on the scope first. NOR support is unverified and unavailable through this typed tool.

- Safety: Setup change
- Inputs:
  - `c1` (optional): C1 in the pattern: X ignores the channel, L is below and H above its trigger level. Accepted values `"X"`, `"L"`, `"H"`.
  - `c2` (optional): C2 in the pattern: X ignores the channel, L is below and H above its trigger level. Accepted values `"X"`, `"L"`, `"H"`.
  - `c3` (optional): C3 in the pattern: X ignores the channel, L is below and H above its trigger level. Accepted values `"X"`, `"L"`, `"H"`.
  - `c4` (optional): C4 in the pattern: X ignores the channel, L is below and H above its trigger level. Accepted values `"X"`, `"L"`, `"H"`.
  - `condition` (required): Boolean operator over channel statuses. NOR support is unverified and unavailable through this typed tool. Accepted values `"AND"`, `"OR"`, `"NAND"`.

<a id="tool-legacy-configure-trigger-window"></a>
### `configure_trigger_window`

Set the height between the two lines of the relative trigger window. The range depends on the center level and source volts per division. The scope may adjust the value. The command applies only while the trigger window type is Relative, which cannot be selected or read through this interface.

- Safety: Setup change
- Inputs:
  - `window_height` (required): Height of the relative trigger window, for example '2V'. The range is 0 to 9 divisions of the source while the center level is 0, so the maximum follows the volts/div and the level. An out-of-range value comes back as a warning.

<a id="tool-legacy-get-i2c-trigger"></a>
### `get_i2c_trigger`

Read I2C serial trigger sources, thresholds, condition, address, data bytes, qualifier, direction, and search lengths. Ignored address or data values are returned as any. Criteria are active only while the trigger type is Serial. SDS1000X-E only.

- Safety: Read-only
- Inputs: none

<a id="tool-legacy-configure-i2c-trigger"></a>
### `configure_i2c_trigger`

Configure I2C serial trigger sources, thresholds, condition, address, data bytes, qualifier, direction, and search lengths. Analog sources require a threshold. Digital sources do not accept one. Criteria must match the selected condition. Use any to ignore address or data values. Select the Serial trigger type first. Choose the I2C bus on the scope. SDS1000X-E only.

- Safety: Setup change
- Inputs:
  - `scl` (optional): serial clock (SCL) source. 20 accepted values.
  - `scl_threshold` (optional): serial clock (SCL) threshold. It is required for an analog source and rejected for a digital one. Its range follows the vertical scale of the source.
  - `sda` (optional): serial data (SDA) source. 20 accepted values.
  - `sda_threshold` (optional): serial data (SDA) threshold. It is required for an analog source and rejected for a digital one. Its range follows the vertical scale of the source.
  - `condition` (optional): I2C trigger condition. Address and data fields depend on the selected condition. Accepted values `"START"`, `"STOP"`, `"RESTART"`, `"NOACK"`, `"EEPROM"`, `"7ADDA"`, `"10ADDA"`, `"DALENTH"`.
  - `address` (optional): address to trigger on, 0 to 127 with condition 7ADDA and 0 to 1023 with 10ADDA, or `any` to ignore it.
  - `data` (optional): first data byte, 0 to 255, or `any` to ignore it.
  - `data2` (optional): second data byte, 0 to 255, or `any` to ignore it.
  - `qualifier` (optional): how data is compared in an EEPROM frame: equal to, greater than or less than. Accepted values `"EQUAL"`, `"MORE"`, `"LESS"`.
  - `direction` (optional): Value of the read/write bit to trigger on. Dont Care triggers on either. Accepted values `"READ"`, `"WRITE"`, `"DONT_CARE"`.
  - `address_length` (optional): address width of a DALENTH search. Accepted values `"7BIT"`, `"10BIT"`.
  - `data_length` (optional): data length of a DALENTH search, 1 to 12 bytes. Minimum 1. Maximum 12.

<a id="tool-legacy-get-spi-trigger"></a>
### `get_spi_trigger`

Read SPI serial trigger sources, thresholds, clock edge and timeout, chip-select type, trigger line, pattern length, and bit order. The data pattern has no query form. Criteria are active only while the trigger type is Serial. SDS1000X-E only.

- Safety: Read-only
- Inputs: none

<a id="tool-legacy-configure-spi-trigger"></a>
### `configure_spi_trigger`

Configure SPI serial trigger sources, thresholds, clock edge and timeout, chip selection, trigger line, data pattern, and bit order. Analog sources require a threshold. Digital sources do not accept one. The data pattern must contain exactly data_length bits and has no query form. Select the Serial trigger type first. Choose the SPI bus on the scope. SDS1000X-E only.

- Safety: Setup change
- Inputs:
  - `clk` (optional): serial clock (CLK) source. 20 accepted values.
  - `clk_threshold` (optional): serial clock (CLK) threshold. It is required for an analog source and rejected for a digital one. Its range follows the vertical scale of the source.
  - `mosi` (optional): master-out slave-in (MOSI) source. 20 accepted values.
  - `mosi_threshold` (optional): master-out slave-in (MOSI) threshold. It is required for an analog source and rejected for a digital one. Its range follows the vertical scale of the source.
  - `miso` (optional): master-in slave-out (MISO) source. 20 accepted values.
  - `miso_threshold` (optional): master-in slave-out (MISO) threshold. It is required for an analog source and rejected for a digital one. Its range follows the vertical scale of the source.
  - `cs` (optional): active-high chip-select (CS) source. 20 accepted values.
  - `cs_threshold` (optional): active-high chip-select (CS) threshold. It is required for an analog source and rejected for a digital one. Its range follows the vertical scale of the source.
  - `ncs` (optional): active-low chip-select (~CS) source. 20 accepted values.
  - `ncs_threshold` (optional): active-low chip-select (~CS) threshold. It is required for an analog source and rejected for a digital one. Its range follows the vertical scale of the source.
  - `edge` (optional): clock edge the data is latched on. Accepted values `"RISING"`, `"FALLING"`.
  - `clock_timeout` (optional): clock timeout of the TIMEOUT chip select, 100ns to 5ms.
  - `chip_select_type` (optional): what delimits a frame: an active-high CS, an active-low ~CS, or a clock timeout. Accepted values `"CS"`, `"NCS"`, `"TIMEOUT"`.
  - `trigger_source` (optional): line the data pattern is matched on. Accepted values `"MOSI"`, `"MISO"`.
  - `data_length` (optional): length of the data pattern in bits, 4 to 96. Minimum 4. Maximum 96.
  - `data` (optional): Data pattern with exactly data_length bits. Use a string such as "10X1" or an array such as ["1","0","X","1"]. X ignores a bit. The data pattern has no query form.
  - `bit_order` (optional): bit the pattern starts at, most or least significant. Accepted values `"MSB"`, `"LSB"`.

<a id="tool-legacy-get-uart-trigger"></a>
### `get_uart_trigger`

Read UART serial trigger sources, thresholds, trigger line, condition, qualifier, data, baud rate, data length, parity, idle level, stop bits, and bit order. Ignored data is returned as any. Criteria are active only while the trigger type is Serial. SDS1000X-E only.

- Safety: Read-only
- Inputs: none

<a id="tool-legacy-configure-uart-trigger"></a>
### `configure_uart_trigger`

Configure UART serial trigger sources, thresholds, trigger line, condition, qualifier, data, baud rate, data length, parity, idle level, stop bits, and bit order. Analog sources require a threshold. Digital sources do not accept one. Data and qualifier require the Data condition. Select the Serial trigger type first. Choose the UART bus on the scope. SDS1000X-E only.

- Safety: Setup change
- Inputs:
  - `rx` (optional): receive (RX) source. 20 accepted values.
  - `rx_threshold` (optional): receive (RX) threshold. It is required for an analog source and rejected for a digital one. Its range follows the vertical scale of the source.
  - `tx` (optional): transmit (TX) source. 20 accepted values.
  - `tx_threshold` (optional): transmit (TX) threshold. It is required for an analog source and rejected for a digital one. Its range follows the vertical scale of the source.
  - `trigger_source` (optional): line the trigger condition is matched on. Accepted values `"RX"`, `"TX"`.
  - `condition` (optional): START, STOP, DATA (a search on a data byte) or ERROR. Accepted values `"START"`, `"STOP"`, `"DATA"`, `"ERROR"`.
  - `qualifier` (optional): how the data byte is compared: equal to, greater than or less than. Accepted values `"EQUAL"`, `"MORE"`, `"LESS"`.
  - `data` (optional): data byte to trigger on, 0 to 255, or `any` to ignore it.
  - `baud` (optional): Baud rate in bits per second from 300 to 5000000. Standard rates are 600, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200. Minimum 300. Maximum 5000000.
  - `data_length` (optional): data length in bits, 5 to 8. Minimum 5. Maximum 8.
  - `parity` (optional): parity check of a frame. Accepted values `"NONE"`, `"ODD"`, `"EVEN"`.
  - `polarity` (optional): idle level of the line. Accepted values `"LOW"`, `"HIGH"`.
  - `stop_bits` (optional): length of the stop bit in bit times. Accepted values `1`, `1.5`, `2`.
  - `bit_order` (optional): bit a frame starts at, least or most significant. Accepted values `"LSB"`, `"MSB"`.

<a id="tool-legacy-get-can-trigger"></a>
### `get_can_trigger`

Read CAN serial trigger source, threshold, condition, identifier length, identifier, data bytes, and baud rate. Ignored identifier or data values are returned as any. Criteria are active only while the trigger type is Serial. SDS1000X-E only.

- Safety: Read-only
- Inputs: none

<a id="tool-legacy-configure-can-trigger"></a>
### `configure_can_trigger`

Configure CAN serial trigger source, threshold, condition, identifier length, identifier, data bytes, and baud rate. Analog sources require a threshold. Digital sources do not accept one. Identifier and data fields must match the selected condition. Use any to ignore them. Baud-rate support beyond common rates is unverified. Select the Serial trigger type first. Choose the CAN bus on the scope. SDS1000X-E only.

- Safety: Setup change
- Inputs:
  - `canh` (optional): CAN high (CANH) source. 20 accepted values.
  - `canh_threshold` (optional): CAN high (CANH) threshold. It is required for an analog source and rejected for a digital one. Its range follows the vertical scale of the source.
  - `condition` (optional): CAN trigger condition. Identifier and data fields depend on the selected condition. Accepted values `"START"`, `"REMOTE"`, `"ID"`, `"ID_AND_DATA"`, `"ERROR"`.
  - `id_length` (optional): width of the identifier, standard or extended. Accepted values `"11BITS"`, `"29BITS"`.
  - `id` (optional): identifier to trigger on, 0 to 2047 with id_length 11BITS and 0 to 536870911 with 29BITS, or `any` to ignore it.
  - `data` (optional): first data byte, 0 to 255, or `any` to ignore it.
  - `data2` (optional): second data byte, 0 to 255, or `any` to ignore it.
  - `baud` (optional): Baud rate in bits per second from 5000 to 1000000. Common rates are 5000, 10000, 20000, 100000, 125000, 500000, 800000, 1000000. Minimum 5000. Maximum 1000000.

<a id="tool-legacy-get-lin-trigger"></a>
### `get_lin_trigger`

Read LIN serial trigger source, threshold, condition, identifier, data bytes, and baud rate. Ignored identifier or data values are returned as any. Criteria are active only while the trigger type is Serial. LIN baud-rate query behavior is unverified on hardware. SDS1000X-E only.

- Safety: Read-only
- Inputs: none

<a id="tool-legacy-configure-lin-trigger"></a>
### `configure_lin_trigger`

Configure LIN serial trigger source, threshold, condition, identifier, data bytes, and baud rate. Analog sources require a threshold. Digital sources do not accept one. Identifier and data fields must match the selected condition. Use any to ignore them. Select the Serial trigger type first. Choose the LIN bus on the scope. SDS1000X-E only.

- Safety: Setup change
- Inputs:
  - `src` (optional): LIN bus source. 20 accepted values.
  - `src_threshold` (optional): LIN bus threshold. It is required for an analog source and rejected for a digital one. Its range follows the vertical scale of the source.
  - `condition` (optional): BREAK (a break condition), ID (a search on the identifier), ID_AND_DATA (a search on the identifier and the data) or DATA_ERROR (an error frame). Accepted values `"BREAK"`, `"ID"`, `"ID_AND_DATA"`, `"DATA_ERROR"`.
  - `id` (optional): identifier to trigger on, 0 to 63, or `any` to ignore it.
  - `data` (optional): first data byte, 0 to 255, or `any` to ignore it.
  - `data2` (optional): second data byte, 0 to 255, or `any` to ignore it.
  - `baud` (optional): Baud rate in bits per second from 300 to 20000. Standard rates are 600, 1200, 2400, 4800, 9600, 19200. Minimum 300. Maximum 20000.

<a id="tool-legacy-get-cursors"></a>
### `get_cursors`

Read the cursor mode, manual cursor type, and all six cursor positions for a trace. Older families support only Manual and Track modes and cannot report an Off state.

- Safety: Read-only
- Inputs:
  - `source` (required): Trace the cursor positions are relative to. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`. Default `"C1"`.

<a id="tool-legacy-configure-cursors"></a>
### `configure_cursors`

Set the cursor mode, manual cursor type, and up to four cursor positions for one trace. Cursor positions require a unit. Their range depends on the grid, time per division, and volts per division, so the scope may clamp them.

- Safety: Setup change
- Inputs:
  - `mode` (optional): Off closes the cursors on SDS1000X-E. Manual and Track select the cursor mode. Accepted values `"off"`, `"manual"`, `"track"`.
  - `type` (optional): Manual cursor type. Ignored in Track mode. Accepted values `"X"`, `"Y"`, `"X-Y"`.
  - `source` (optional): Trace the cursor positions are relative to. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`.
  - `positions` (optional): Cursor positions with unit, e.g. { TREF: '-3US', VDIF: '-500MV' }.

<a id="tool-legacy-measure-cursors"></a>
### `measure_cursors`

Read cursor measurements for a trace. Horizontal measurements return the time difference, reciprocal frequency, and both cursor times. Vertical measurements return the voltage difference and both cursor voltages. Non-SPO models return only the difference.

- Safety: Read-only
- Inputs:
  - `source` (required): Analog channel. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`.
  - `measurement` (required): Horizontal time cursors or vertical voltage cursors. Accepted values `"HREL"`, `"VREL"`.

<a id="tool-legacy-get-decode"></a>
### `get_decode`

Read whether serial decoding is enabled. Common and protocol-specific decode settings have no query form and cannot be read back.

- Safety: Read-only
- Inputs: none

<a id="tool-legacy-configure-decode"></a>
### `configure_decode`

Enable serial decoding and configure the active bus, decode list, number format, copy direction between trigger and decoder, list position, and number of list lines. Decode is an SDS1000X-E feature. Common settings have no query form.

- Safety: Setup change
- Inputs:
  - `enabled` (optional): Turn serial decoding on or off.
  - `bus` (optional): bus the following decode settings apply to. Accepted values `"B1"`, `"B2"`.
  - `list` (optional): OFF, or the decode list of bus 1 (D1) or bus 2 (D2). Accepted values `"OFF"`, `"D1"`, `"D2"`.
  - `format` (optional): number format of the decoded data. Accepted values `"BIN"`, `"DEC"`, `"HEX"`.
  - `copy` (optional): TR_TO_DC copies the trigger setup into the decoder, DC_TO_TR copies the decoder into the trigger. Accepted values `"TR_TO_DC"`, `"DC_TO_TR"`.
  - `list_scroll` (optional): list line to scroll to, 1 to the number of list lines. Minimum 1. Maximum 7.
  - `list_lines` (optional): number of list lines, 1 to 7. Minimum 1. Maximum 7.

<a id="tool-legacy-configure-i2c-decode"></a>
### `configure_i2c_decode`

Configure the I2C decoder for bus B1 or B2, including visibility, clock and data sources, thresholds, and whether the read/write bit belongs to the address. Analog sources require a threshold in volts. Digital sources do not accept one. The command has no query form.

- Safety: Setup change
- Inputs:
  - `bus` (required): Decode bus. Accepted values `"B1"`, `"B2"`.
  - `display` (optional): show this bus.
  - `scl` (optional): clock source. 20 accepted values.
  - `scl_threshold` (optional): clock threshold, required for an analog SCL source.
  - `sda` (optional): data source. 20 accepted values.
  - `sda_threshold` (optional): data threshold, required for an analog SDA source.
  - `read_write` (optional): include the read/write bit in the address.

<a id="tool-legacy-configure-spi-decode"></a>
### `configure_spi_decode`

Configure the SPI decoder for bus B1 or B2, including visibility, clock and data sources, latch edge, chip selection, bit order, and data length. Analog sources require a threshold in volts. Digital sources do not accept one. The command has no query form.

- Safety: Setup change
- Inputs:
  - `bus` (required): Decode bus. Accepted values `"B1"`, `"B2"`.
  - `display` (optional): show this bus.
  - `clk` (optional): clock source. 20 accepted values.
  - `clk_threshold` (optional): clock threshold, required for an analog CLK source.
  - `edge` (optional): clock edge the data is latched on. Accepted values `"RISING"`, `"FALLING"`.
  - `miso` (optional): master-in slave-out source. 20 accepted values.
  - `miso_threshold` (optional): master-in slave-out threshold, required for an analog MISO source.
  - `mosi` (optional): master-out slave-in source. 20 accepted values.
  - `mosi_threshold` (optional): master-out slave-in threshold, required for an analog MOSI source.
  - `chip_select_type` (optional): chip selection by CS, by ~CS, or by clock timeout. Accepted values `"CS"`, `"NCS"`, `"TIMEOUT"`.
  - `cs` (optional): active-high chip-select source. 20 accepted values.
  - `cs_threshold` (optional): active-high chip-select threshold, required for an analog CS source.
  - `ncs` (optional): active-low chip-select source. 20 accepted values.
  - `ncs_threshold` (optional): active-low chip-select threshold, required for an analog NCS source.
  - `timeout` (optional): clock timeout used by chip_select_type TIMEOUT.
  - `bit_order` (optional): bit order of the decoded data. Accepted values `"MSB"`, `"LSB"`.
  - `data_length` (optional): data length in bits, 4 to 32. Minimum 4. Maximum 32.

<a id="tool-legacy-configure-uart-decode"></a>
### `configure_uart_decode`

Configure the UART decoder for bus B1 or B2, including visibility, receive and transmit sources, thresholds, baud rate, data length, parity, stop bits, idle level, and bit order. Analog sources require a threshold in volts. Digital sources do not accept one. The command has no query form.

- Safety: Setup change
- Inputs:
  - `bus` (required): Decode bus. Accepted values `"B1"`, `"B2"`.
  - `display` (optional): show this bus.
  - `rx` (optional): receive source. 20 accepted values.
  - `rx_threshold` (optional): receive threshold, required for an analog RX source.
  - `tx` (optional): transmit source. 20 accepted values.
  - `tx_threshold` (optional): transmit threshold, required for an analog TX source.
  - `baud` (optional): baud rate in bit/s without a unit, 300 to 50000000. Minimum 300. Maximum 50000000.
  - `data_length` (optional): data length in bits, 5 to 8. Minimum 5. Maximum 8.
  - `parity` (optional): parity check. Accepted values `"NONE"`, `"EVEN"`, `"ODD"`.
  - `stop_bits` (optional): length of the stop bit. Accepted values `1`, `1.5`, `2`.
  - `polarity` (optional): idle level of the bus. Accepted values `"LOW"`, `"HIGH"`.
  - `bit_order` (optional): bit order of the decoded data. Accepted values `"MSB"`, `"LSB"`.

<a id="tool-legacy-configure-can-decode"></a>
### `configure_can_decode`

Configure the CAN decoder for bus B1 or B2, including visibility, CANH and CANL sources, thresholds, decoded signal, and baud rate. Analog sources require a threshold in volts. Digital sources do not accept one. The command has no query form.

- Safety: Setup change
- Inputs:
  - `bus` (required): Decode bus. Accepted values `"B1"`, `"B2"`.
  - `display` (optional): show this bus.
  - `canh` (optional): CANH source. 20 accepted values.
  - `canh_threshold` (optional): CANH threshold, required for an analog CANH source.
  - `canl` (optional): CANL source. 20 accepted values.
  - `canl_threshold` (optional): CANL threshold, required for an analog CANL source.
  - `signal` (optional): Signal to decode. Accepted values `"CAN_H"`, `"CAN_L"`, `"SUB_L"`.
  - `baud` (optional): baud rate in bit/s without a unit, 5000 to 1000000. Minimum 5000. Maximum 1000000.

<a id="tool-legacy-configure-lin-decode"></a>
### `configure_lin_decode`

Configure the LIN decoder for bus B1 or B2, including visibility, source, threshold, and baud rate. An analog source requires a threshold in volts. A digital source does not accept one. The command has no query form. Baud rates above 2000 are unverified.

- Safety: Setup change
- Inputs:
  - `bus` (required): Decode bus. Accepted values `"B1"`, `"B2"`.
  - `display` (optional): show this bus.
  - `src` (optional): LIN bus source. 20 accepted values.
  - `src_threshold` (optional): LIN bus threshold, required for an analog SRC source.
  - `baud` (optional): Baud rate in bits per second without a unit, from 300 to 20000. Rates above 2000 are unverified. Minimum 300. Maximum 20000.

<a id="tool-legacy-get-digital"></a>
### `get_digital`

Read the digital function state, visibility of the requested lines D0-D15, and thresholds of the D0-D7 and D8-D15 groups. MSO option support is reported because it cannot be inferred from the model name.

- Safety: Read-only
- Inputs:
  - `lines` (required): Digital lines to read. Defaults to D0-D15. Default `["D0","D1","D2","D3","D4","D5","D6","D7","D8","D9","D10","D11","D12","D13","D14","D15"]`.

<a id="tool-legacy-configure-digital"></a>
### `configure_digital`

Turn the digital function on or off, show or hide individual lines D0-D15, and set thresholds for the D0-D7 and D8-D15 groups. Threshold preset names differ between SDS2000X/SDS1000X and SDS1000X-E.

- Safety: Setup change
- Inputs:
  - `enabled` (optional): Turn the digital function on or off.
  - `lines` (optional): Display state per digital line, e.g. { D0: true, D8: false }.
  - `thresholds` (optional): Thresholds for the D0-D7 and D8-D15 groups, for example { d0_d7: { mode: 'CMOS3.3' } }.

<a id="tool-legacy-get-display"></a>
### `get_display`

Read the display configuration, including interpolation, graticule, menu visibility, persistence, and grid and trace intensity.

- Safety: Read-only
- Inputs: none

<a id="tool-legacy-configure-display"></a>
### `configure_display`

Configure display interpolation, graticule, menu visibility, persistence, and grid and trace intensity. Low intensity values may be clamped. Disabling persistence is available only on SDS1000X-E.

- Safety: Setup change
- Inputs:
  - `join_points` (optional): Draw interpolation lines between sample points. Disable to show dots.
  - `grid` (optional): graticule type. Accepted values `"FULL"`, `"HALF"`, `"OFF"`.
  - `menu` (optional): show the on-screen menu.
  - `persistence` (optional): Persistence duration in seconds. Off is available only on SDS1000X-E. Accepted values `"OFF"`, `"INFINITE"`, `1`, `5`, `10`, `30`.
  - `grid_intensity` (optional): graticule brightness in percent. Minimum 0. Maximum 100.
  - `trace_intensity` (optional): trace brightness in percent. Minimum 0. Maximum 100.

<a id="tool-legacy-get-history"></a>
### `get_history`

Read history mode, the current frame, history-list visibility, and the current frame timestamp. Full history state is available only on SDS1000X-E. Other families return the timestamp as hexadecimal unless it can be decoded as text.

- Safety: Read-only
- Inputs:
  - `timeout_ms` (optional): Timestamp read timeout in milliseconds. Binary timestamps default to 5000. Minimum 100. Maximum 120000.

<a id="tool-legacy-configure-history"></a>
### `configure_history`

Turn history mode on or off, select a frame, and show or hide the history list. Selecting a frame or showing the list requires history mode. The scope may clamp unavailable frame numbers. On models outside SDS1000X-E, frame selection is sent without verification.

- Safety: Setup change
- Inputs:
  - `enabled` (optional): History mode on or off. A frame and the history list require it to be on.
  - `frame` (optional): frame to show, 0 to the newest frame the scope holds. Minimum 0. Maximum 9007199254740991.
  - `list` (optional): show the history list next to the waveform.

<a id="tool-legacy-get-math"></a>
### `get_math`

Read the math operation, sources, inversion, vertical scale, and vertical position in pixels. An unrecognized equation is returned unparsed in equation_raw.

- Safety: Read-only
- Inputs: none

<a id="tool-legacy-configure-math"></a>
### `configure_math`

Configure the math waveform. Add, Subtract, Multiply, and Divide take two channel sources. FFT, Integrate, Differentiate, and Square Root take one. Inversion and vertical scale are available only for arithmetic operations. Configure FFT vertical position with configure_fft.

- Safety: Setup change
- Inputs:
  - `operation` (optional): Waveform math operation. Accepted values `"add"`, `"subtract"`, `"multiply"`, `"divide"`, `"fft"`, `"integrate"`, `"differentiate"`, `"sqrt"`.
  - `sources` (optional): Source channels. Arithmetic operations take two. Transform operations take one.
  - `inverted` (optional): Invert the math waveform. Available only for add, subtract, multiply, and divide.
  - `vertical_scale` (optional): Volts per division of the math waveform. Available only for add, subtract, multiply, and divide. 17 accepted values.
  - `vertical_position` (optional): Vertical position from -255 to 255 screen pixels. One division is 50 pixels. Not available for FFT. Minimum -255. Maximum 255.

<a id="tool-legacy-get-fft"></a>
### `get_fft`

Read the FFT operation, source, scale type, vertical scale, vertical offset, center frequency, display mode, window, and horizontal scale in hertz per division. Scale type, vertical offset, center frequency, and horizontal scale are available only on SDS1000X-E.

- Safety: Read-only
- Inputs: none

<a id="tool-legacy-configure-fft"></a>
### `configure_fft`

Configure the FFT waveform. Providing a source switches the math operation to FFT. Without a source, the current operation must already be FFT. DBM and DBVRMS scale types support vertical scales from 0.1 and above. Vertical position requires VRMS. Scale type, vertical position, and center frequency are available only on SDS1000X-E. The scope may clamp center frequency or vertical position.

- Safety: Setup change
- Inputs:
  - `source` (optional): Channel used as the FFT source. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`.
  - `scale_unit` (optional): Vertical scale type. The scale and offset use this unit. Accepted values `"VRMS"`, `"DBM"`, `"DBVRMS"`.
  - `vertical_scale` (optional): Vertical scale per division. DBM and DBVRMS support values from 0.1 and above. 14 accepted values.
  - `vertical_position` (optional): Vertical offset from -24.4 to 15.6 divisions of the current scale. Available only with the VRMS scale type.
  - `center_frequency` (optional): Center frequency. The allowed range follows the horizontal scale and varies by model.
  - `display_mode` (optional): OFF split screen, ON full screen, EXCLU exclusive. Accepted values `"OFF"`, `"ON"`, `"EXCLU"`.
  - `window` (optional): window function: rectangle, Blackman, Hanning, Hamming or flattop. Accepted values `"RECT"`, `"BLAC"`, `"HANN"`, `"HAMM"`, `"FLATTOP"`.

<a id="tool-legacy-read-frequency-counter"></a>
### `read_frequency_counter`

Read the hardware frequency counter for the current trigger source and slope. Signals below 10 Hz are returned as a bound. A plain 10 Hz result may also represent a slower signal and includes a warning.

- Safety: Read-only
- Inputs: none

<a id="tool-legacy-measure-delay"></a>
### `measure_delay`

Install and read a delay measurement between channels C1-C4. This enables continuous measurement mode and changes the measurement pane. Phase is returned in degrees. Edge delays and skew are returned as times. The first source must precede the second.

- Safety: Setup change
- Inputs:
  - `source_a` (required): First channel of the pair. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`.
  - `source_b` (required): Second channel of the pair. Must follow source_a. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`.
  - `type` (required): Delay type. Phase is measured in degrees. Accepted values `"PHA"`, `"FRR"`, `"FRF"`, `"FFR"`, `"FFF"`, `"LRR"`, `"LRF"`, `"LFR"`, `"LFF"`, `"SKEW"`.

<a id="tool-legacy-measure"></a>
### `measure`

Install a measurement on a channel and read its value. Installing it changes the measurement pane. A single parameter returns its value and unit. All returns every available parameter. Unavailable values are preserved as raw text.

- Safety: Setup change
- Inputs:
  - `channel` (required): Analog channel. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`.
  - `parameter` (required): Measurement parameter, ALL snapshots every parameter into values. 24 accepted values.

<a id="tool-legacy-read-measurement"></a>
### `read_measurement`

Read one measurement parameter from a channel without installing it or using a custom slot. All returns every available parameter. Unavailable values are preserved as raw text.

- Safety: Read-only
- Inputs:
  - `channel` (required): Analog channel. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`.
  - `parameter` (required): Measurement parameter, ALL snapshots every parameter into values. 24 accepted values.

<a id="tool-legacy-list-measurements"></a>
### `list_measurements`

List installed measurements with their slot number, source channel, parameter, and current value. A slot reported as Off is available.

- Safety: Read-only
- Inputs:
  - `slot` (optional): Read one custom slot 1-5 instead of all five. Accepted values `1`, `2`, `3`, `4`, `5`.

<a id="tool-legacy-get-measurement-statistics"></a>
### `get_measurement_statistics`

Read current, mean, minimum, maximum, standard deviation, and count for installed measurements. Filter by channel or parameter, or read every installed slot. Statistics must be enabled first with configure_measurement_statistics. SDS1000X-E only.

- Safety: Read-only
- Inputs:
  - `channel` (optional): Only report slots measuring this channel. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`.
  - `parameter` (optional): Only report slots measuring this parameter. 24 accepted values.

<a id="tool-legacy-configure-measurement-statistics"></a>
### `configure_measurement_statistics`

Turn measurement statistics on or off, or clear accumulated values. Statistics apply to measurements installed with measure. Read them with get_measurement_statistics. Reset has no query form. SDS1000X-E only.

- Safety: Setup change
- Inputs:
  - `statistics` (optional): Measurement statistics. On accumulates current, mean, minimum, maximum, standard deviation, and count. Off stops accumulation. Reset clears accumulated values. Accepted values `"OFF"`, `"ON"`, `"RESET"`.

<a id="tool-legacy-clear-measurements"></a>
### `clear_measurements`

Remove every installed measurement and free all custom slots. Individual slots or channels cannot be cleared. This cannot be undone. The command has no query form. SDS1000X-E only.

- Safety: Destructive
- Inputs: none

<a id="tool-legacy-get-measurement-gate"></a>
### `get_measurement_gate`

Read whether measurement gating is enabled. Gate positions have no query form and cannot be read back. SDS1000X-E only.

- Safety: Read-only
- Inputs: none

<a id="tool-legacy-configure-measurement-gate"></a>
### `configure_measurement_gate`

Turn measurement gating on or off and set the left and right gate positions. Only the waveform between them is measured. Positions require a time unit and may be clamped to the timebase and horizontal position. Gate positions have no query form and cannot be verified. Gate A must not follow gate B. SDS1000X-E only.

- Safety: Setup change
- Inputs:
  - `enabled` (optional): gate measurement: only the waveform between gate A and gate B is measured.
  - `gate_a` (optional): Left gate position, for example '20us'. A value without a unit means seconds.
  - `gate_b` (optional): right gate position, never before gate A, e.g. '1.68ms'.

<a id="tool-legacy-get-pass-fail-mask"></a>
### `get_pass_fail_mask`

Read the pass/fail mask source channel, X and Y tolerances in divisions, and failure alarm. Resetting statistics and creating a mask have no query form. SDS1000X-E only.

- Safety: Read-only
- Inputs: none

<a id="tool-legacy-configure-pass-fail-mask"></a>
### `configure_pass_fail_mask`

Set the pass/fail mask source, X and Y tolerances, and failure alarm. Both tolerances must be provided together. The alarm sounds the buzzer independently of the general sound setting. Creating a mask replaces the active rule, enables the test, and stops a running test. It requires `confirm_replace_mask: true`. SDS1000X-E only.

- Safety: Destructive
- Inputs:
  - `source` (optional): channel the mask is built around. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`.
  - `x_mask` (optional): tolerance in the X direction in divisions, sent in PFST. Minimum 0.04. Maximum 4.
  - `y_mask` (optional): tolerance in the Y direction in divisions, sent in PFST. Minimum 0.04. Maximum 4.
  - `buzzer` (optional): Show statistics and sound the buzzer on a failed waveform. The buzzer is independent of the general sound setting.
  - `create_mask` (optional): Build the mask from the source and tolerances.
  - `confirm_replace_mask` (optional): Explicit acknowledgement that the active pass/fail rule is replaced and a running test stopped. Required value `true`.

<a id="tool-legacy-reset-pass-fail-statistics"></a>
### `reset_pass_fail_statistics`

Reset the failed, passed, and total pass/fail frame counts to zero. The command has no query form. SDS1000X-E only.

- Safety: Setup change
- Inputs: none

<a id="tool-legacy-get-pass-fail"></a>
### `get_pass_fail`

Read the pass/fail test state, display setting, stop-on-fail setting, and failed, passed, and total frame counts. Counts are returned exactly as reported and include the raw response. Use get_pass_fail_mask to read the mask. SDS1000X-E only.

- Safety: Read-only
- Inputs: none

<a id="tool-legacy-configure-pass-fail"></a>
### `configure_pass_fail`

Enable, display, start, or stop the pass/fail test. Starting or displaying the test enables the feature when needed. Stop-on-fail stops acquisition on the first failed frame and leaves the scope stopped. The test uses the active mask, whose existence cannot be confirmed because mask creation has no query form. SDS1000X-E only.

- Safety: Setup change
- Inputs:
  - `enabled` (optional): enable the pass/fail test feature, which the mask, the display and a run all need.
  - `display` (optional): show the failed, passed and total frame counts on screen.
  - `stop_on_fail` (optional): Stop acquisition on the first failed frame, leaving the scope stopped with the last statistics visible. Off keeps testing and updates them.
  - `running` (optional): run or stop the pass/fail test.

<a id="tool-legacy-capture-screenshot"></a>
### `capture_screenshot`

Capture the screen as a BMP image. The communication header must be Off. Transfers default to a 20-second timeout and are limited to 4 MiB. The image is returned as an MCP image content block, which some clients cannot display. Set include_image to false to return only image metadata.

- Safety: Read-only
- Inputs:
  - `include_image` (required): Attach the BMP as an image content block. False returns only image metadata. Default `true`.
  - `timeout_ms` (optional): Transfer timeout in milliseconds, default 20000. Minimum 100. Maximum 120000.

<a id="tool-legacy-capture-panel-setup"></a>
### `capture_panel_setup`

Capture the complete front-panel setup and keep it in the server under a restorable setup ID. Returns the ID, format, byte count, and SHA-256 hash. Set include_payload to true to attach the setup as a resource. Transfers larger than 16 MiB are refused. The server keeps the last eight captures, up to 16 MiB total, until the connection closes. Use save_panel_setup for persistent storage. Setup compatibility across firmware versions is not guaranteed.

- Safety: Read-only
- Inputs:
  - `include_payload` (required): Also attach the setup as an embedded resource (XML text or base64 blob). Default `false`.
  - `timeout_ms` (optional): Transfer timeout in milliseconds. Default 15000. Use at least 10000. Minimum 100. Maximum 120000.

<a id="tool-legacy-restore-panel-setup"></a>
### `restore_panel_setup`

Restore a front-panel setup captured by this server, wait for completion, restore the communication header, and identify the scope again. Restoring replaces every scope setting. Only setup IDs from capture_panel_setup are accepted, and only for the same model. Firmware compatibility is not guaranteed. Requires `confirm_restore: true`. Nothing is sent otherwise.

- Safety: Destructive
- Inputs:
  - `setup_id` (required): Id of a setup captured with capture_panel_setup.
  - `confirm_restore` (required): Explicit acknowledgement that the current front-panel setup is discarded. Required value `true`.
  - `timeout_ms` (optional): Completion timeout in milliseconds, default 30000. Minimum 100. Maximum 120000.

<a id="tool-legacy-save-panel-setup"></a>
### `save_panel_setup`

Save the current front-panel setup to internal slot 1-20 or a USB file, then wait for completion. Existing setups cannot be detected and are replaced without warning. Requires `confirm_overwrite: true`. File names support up to eight letters, digits, underscores, or hyphens. SDS1000X-E uses .xml. Other models use .set.

- Safety: Destructive
- Inputs:
  - `slot` (optional): Internal setup slot 1-20. Minimum 1. Maximum 20.
  - `usb` (optional): File on the USB memory device.
  - `confirm_overwrite` (required): Explicit acknowledgement that an existing setup in that slot or file is replaced. Required value `true`.
  - `timeout_ms` (optional): Completion timeout in milliseconds, default 30000. Minimum 100. Maximum 120000.

<a id="tool-legacy-recall-panel-setup"></a>
### `recall_panel_setup`

Recall a front-panel setup from internal slot 0-20 or a USB file, wait for completion, restore the communication header, and identify the scope again. Slot 0 restores the default setup. Recalling replaces every scope setting. Requires `confirm_recall: true`. Nothing is sent otherwise.

- Safety: Destructive
- Inputs:
  - `slot` (optional): Internal setup slot 0-20. Slot 0 recalls the default setup. Minimum 0. Maximum 20.
  - `usb` (optional): File on the USB memory device.
  - `confirm_recall` (required): Explicit acknowledgement that the current front-panel setup is discarded. Required value `true`.
  - `timeout_ms` (optional): Completion timeout in milliseconds, default 30000. Minimum 100. Maximum 120000.

<a id="tool-legacy-get-reference"></a>
### `get_reference`

Read the selected reference channel, its source, visibility, vertical scale, and vertical offset. Closing and saving a reference have no query form and cannot be read back. SDS1000X-E only.

- Safety: Read-only
- Inputs: none

<a id="tool-legacy-configure-reference"></a>
### `configure_reference`

Select and configure a reference channel. Sources are channels C1-C4 or Math. Saving stores the visible waveform range and replaces the selected reference. Saving requires a location and `confirm_overwrite_reference: true`. Display and vertical settings require a saved reference. The vertical scale is 500uV to 10V. The scope may clamp the vertical offset. SDS1000X-E only.

- Safety: Destructive
- Inputs:
  - `location` (optional): reference channel every other reference command acts on. Accepted values `"REFA"`, `"REFB"`, `"REFC"`, `"REFD"`.
  - `source` (optional): waveform the reference channel is saved from. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`, `"MATH"`.
  - `display` (optional): Show the selected reference channel. The channel must contain a saved waveform.
  - `vertical_scale` (optional): Vertical scale per division from 500uV to 10V. The reference must be saved and displayed.
  - `vertical_position` (optional): Vertical offset. The allowed range follows the scale. The scope clamps to the nearest allowed value.
  - `save` (optional): Store the source waveform in the selected reference channel and display it.
  - `confirm_overwrite_reference` (optional): Explicit acknowledgement that the waveform stored in the selected reference channel is replaced. Required value `true`.

<a id="tool-legacy-close-reference"></a>
### `close_reference`

Close the Reference function. The command has no query form. Its effect on stored waveforms is unknown. SDS1000X-E only.

- Safety: Destructive
- Inputs: none

<a id="tool-legacy-get-waveform"></a>
### `get_waveform`

Transfer a waveform from channels C1-C4, Math, or digital lines D0-D15. Math and digital sources require SDS1000X-E, and digital sources require the MSO option. FFT waveforms are not supported. Analog and Math samples are returned as time and voltage when the sample resolution is known, otherwise as raw codes. Digital samples are returned as time and logic state. Transfers default to 1000 points and a 30-second timeout. Up to 4096 points are returned inline or 200000 as a CSV resource. Transfers larger than 16 MiB are refused. This tool changes the persistent waveform-transfer settings.

- Safety: Setup change
- Inputs:
  - `source` (optional): C1-C4, Math, or D0-D15. channel is accepted as an alias. 21 accepted values.
  - `channel` (optional): Alias of source. 21 accepted values.
  - `sparsing` (optional): Interval between transferred points. Values 0 and 1 transfer every point. Minimum 0. Maximum 14000000.
  - `points` (optional): Number of points to transfer. Zero transfers the whole record. Minimum 0. Maximum 14000000.
  - `first_point` (optional): index of the first point to transfer, 0 is the first acquired point. Minimum 0. Maximum 14000000.
  - `output` (required): Points returns samples inline. Summary returns only statistics. CSV attaches samples as a resource. Accepted values `"points"`, `"summary"`, `"csv"`. Default `"points"`.
  - `horizontal_divisions` (required): Horizontal grid divisions used to calculate the first point time. Defaults to 14. Default `14`. Minimum 1. Maximum 20.
  - `timeout_ms` (optional): Transfer timeout in milliseconds, default 30000. Minimum 100. Maximum 120000.

<a id="tool-legacy-get-waveform-generator"></a>
### `get_waveform_generator`

Read the built-in waveform generator model, frequency limit, output settings, and stored arbitrary waveforms. Arbitrary-waveform selection has no query form. AWG option support is reported because it cannot be inferred from the model name.

- Safety: Read-only
- Inputs:
  - `store` (required): Debug lists built-in and user waveforms. Release lists only user waveforms. Accepted values `"DEBUG"`, `"RELEASE"`. Default `"DEBUG"`.
  - `waveforms` (optional): Stored waveform locations to read. Defaults to non-empty entries.

<a id="tool-legacy-configure-waveform-generator"></a>
### `configure_waveform_generator`

Configure the built-in waveform generator and switch its output on or off. Waveform parameters must match the selected type. Enabling the output or changing a live signal drives the connected circuit and requires `confirm_output_enable: true`. Disabling the output requires no confirmation. Waveform type compatibility is unverified on some models.

- Safety: Destructive
- Inputs:
  - `waveform` (optional): Waveform type and its parameters, for example { type: "SQUARE", duty: 45 }.
  - `load` (optional): Output load. HZ means high impedance. 50 means 50 ohms. Accepted values `"50"`, `"HZ"`.
  - `arbitrary_index` (optional): Stored arbitrary waveform 0-9. Minimum 0. Maximum 9.
  - `output` (optional): Turn the generator output on or off.
  - `confirm_output_enable` (optional): Explicit acknowledgement that the WGEN BNC drives a signal into the connected circuit. Required value `true`.

<a id="tool-legacy-get-obsolete-settings"></a>
### `get_obsolete_settings`

Read the inventory and available values of obsolete commands supported by this scope. Each entry explains its former purpose, supported model series, and current replacement. Unsupported commands are listed without a value. Commands without a query form are marked write-only. Obsolete commands may be removed from future products.

- Safety: Read-only
- Inputs: none

<a id="tool-legacy-send-obsolete-command"></a>
### `send_obsolete_command`

Send one obsolete command using only the fields supported by that command and model series. Overwriting a reference or memory cannot be detected or read back. Commands without a query form are marked write-only. Requires `confirm_obsolete: true`. Nothing is sent otherwise. The result names the current replacement tool. Obsolete commands may be removed from future products.

- Safety: Destructive
- Inputs:
  - `command` (required): Obsolete command to send. get_obsolete_settings lists them. 15 accepted values.
  - `confirm_obsolete` (required): Explicit acknowledgement that an obsolete command is sent instead of its current equivalent. Required value `true`.
  - `quick_calibration` (optional): quick calibration of the instrument.
  - `autoset_type` (optional): SP one period, MP multiple periods, RS trigger on the rising side, DRP on the falling side, RC back to the state before auto-setup. Accepted values `"SP"`, `"MP"`, `"RS"`, `"DRP"`, `"RC"`.
  - `counter_display` (optional): cymometer display on the screen.
  - `data_depth` (optional): Max saves the maximum data depth. Display saves the depth shown on screen. Only the three oldest series support this field. Accepted values `"MAX"`, `"DIS"`.
  - `save_parameters` (optional): the parameter block of the CSV file.
  - `day` (optional): day of the month, 1 to 31. Minimum 1. Maximum 31.
  - `month` (optional): month, JAN to DEC. Accepted values `"JAN"`, `"FEB"`, `"MAR"`, `"APR"`, `"MAY"`, `"JUN"`, `"JUL"`, `"AUG"`, `"SEP"`, `"OCT"`, `"NOV"`, `"DEC"`.
  - `year` (optional): year, 1990 to 2089. Minimum 1990. Maximum 2089.
  - `hour` (optional): hour, 0 to 23. Minimum 0. Maximum 23.
  - `minute` (optional): minute, 0 to 59. Minimum 0. Maximum 59.
  - `second` (optional): second, 0 to 59. Minimum 0. Maximum 59.
  - `fft_zoom` (optional): zoom factor of the FFT trace. Accepted values `1`, `2`, `5`, `10`.
  - `channel` (optional): Analog channel whose filter is configured. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`.
  - `filter_enabled` (optional): filter of the channel, configured by FILTS.
  - `filter_type` (optional): LP low-pass, HP high-pass, BP band-pass, BR band-reject. Accepted values `"LP"`, `"HP"`, `"BP"`, `"BR"`.
  - `upper_limit` (optional): Upper limit frequency. Available only for Low Pass, Band Pass, and Band Reject.
  - `lower_limit` (optional): Lower limit frequency. Available only for High Pass, Band Pass, and Band Reject.
  - `peak_detect` (optional): peak-detect acquisition.
  - `source` (optional): analog channel the test runs on. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`.
  - `operate` (optional): START runs the test, STOP ends it. Accepted values `"START"`, `"STOP"`.
  - `output` (optional): fire the output on a failed or on a passed frame. Accepted values `"FAIL"`, `"PASS"`.
  - `stop_on_output` (optional): stopping the test as soon as the output fires.
  - `persistence` (optional): persistence display mode.
  - `memory` (optional): Internal waveform memory to replace. M1-M10 are generally available. CFL models also support M11-M20. 20 accepted values.
  - `device` (optional): Mass-storage device containing the file. Only a connected USB memory device is supported. Required value `"UDSK"`.
  - `file` (optional): Waveform file on the USB memory device.
  - `reference_source` (optional): trace the reference waveform is taken from. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`, `"MATH"`.
  - `reference` (optional): Reference waveform RA-RD to configure. Accepted values `"RA"`, `"RB"`, `"RC"`, `"RD"`.
  - `display` (optional): the named reference waveform on screen.
  - `save_to_reference` (optional): Save the trace into the selected reference waveform, replacing its current contents. Required value `true`.
  - `trace` (optional): FFT trace to move. Accepted values `"TA"`, `"TB"`, `"TC"`, `"TD"`.
  - `vertical_position` (optional): vertical position, -20 to 20 divisions of the current scale.

## EN11F oscilloscope

<a id="tool-en11f-identify"></a>
### `identify`

Identify the connected oscilloscope. Returns the manufacturer, model, serial number, firmware, device family and channel count.

- Safety: Read-only
- Inputs: none

<a id="tool-en11f-wait-until-complete"></a>
### `wait_until_complete`

Wait until all pending scope operations have finished. Blocks the connection until the scope answers or the timeout expires. A timeout closes the connection.

- Safety: Read-only
- Inputs:
  - `timeout_ms` (optional): Response timeout in milliseconds. Minimum 100. Maximum 120000.

<a id="tool-en11f-reset-scope"></a>
### `reset_scope`

Reset the scope to factory defaults, wait for completion and identify it again. Requires confirm_reset: true. Nothing is sent otherwise.

- Safety: Destructive
- Inputs:
  - `confirm_reset` (required): Explicit acknowledgement that all scope settings are discarded. Required value `true`.
  - `timeout_ms` (optional): Completion timeout in milliseconds, default 30000. Minimum 100. Maximum 120000.

<a id="tool-en11f-scpi-query"></a>
### `scpi_query`

Send a raw SCPI query and return its text response. Use this for operations without a typed tool. A query that does not answer before the timeout closes the connection.

- Safety: Destructive
- Inputs:
  - `command` (required): SCPI query, for example ':CHANnel1:SCALe?'. Minimum length 1. Maximum length 256.
  - `timeout_ms` (optional): Response timeout in milliseconds. Minimum 100. Maximum 120000.

<a id="tool-en11f-scpi-command"></a>
### `scpi_command`

Send a raw SCPI command without reading a response. Escape hatch for commands without a typed tool.

- Safety: Destructive
- Inputs:
  - `command` (required): SCPI command, for example ':CHANnel1:SCALe 5.00E-01'. Minimum length 1. Maximum length 256.

<a id="tool-en11f-autoset-scope"></a>
### `autoset_scope`

Automatically adjust the vertical scale, timebase and trigger to display the input signals, then wait for completion. Signals below 100 Hz may not produce useful settings. Requires confirm_autoset: true. Nothing is sent otherwise.

- Safety: Destructive
- Inputs:
  - `confirm_autoset` (required): Explicit acknowledgement that channel, timebase and trigger settings change. Required value `true`.
  - `timeout_ms` (optional): Completion timeout in milliseconds, default 15000. Minimum 100. Maximum 120000.

<a id="tool-en11f-capture-screenshot"></a>
### `capture_screenshot`

Capture the screen as a BMP image. Transfers are limited to 8 MiB and 20 seconds by default. Some MCP clients cannot display BMP images. Set include_image to false to return header metadata only.

- Safety: Read-only
- Inputs:
  - `inverted` (required): Use the inverted colour scheme. Default `false`.
  - `include_image` (required): Attach the BMP as an image content block. False returns header metadata only. Default `true`.
  - `timeout_ms` (optional): Transfer timeout in milliseconds, default 20000. Minimum 100. Maximum 120000.

<a id="tool-en11f-get-data-format"></a>
### `get_data_format`

Read the precision used for numeric responses.

- Safety: Read-only
- Inputs: none

<a id="tool-en11f-configure-data-format"></a>
### `configure_data_format`

Set the precision of numeric responses. Single uses 7 significant digits, Double uses 14 and Custom uses 1 to 64. This setting is shared by every client connected to the scope.

- Safety: Setup change
- Inputs:
  - `precision` (required): Precision of returned numbers. Accepted values `"SINGle"`, `"DOUBle"`, `"CUSTom"`.
  - `digits` (optional): Significant digits. Custom precision only. Minimum 1. Maximum 64.

<a id="tool-en11f-get-acquisition"></a>
### `get_acquisition`

Read the acquisition mode, capture rate, interpolation, sequence settings, acquisition type, memory management, memory depth, sample rate, acquisition count and sampled points. ADC resolution is included on SDS2000X Plus models. Use get_timebase for horizontal settings.

- Safety: Read-only
- Inputs: none

<a id="tool-en11f-configure-acquisition"></a>
### `configure_acquisition`

Set the acquisition mode, capture rate, interpolation, sequence settings, acquisition type and memory settings, then read back the requested values. Average count applies to Average acquisition and enhanced bits applies to Enhanced Resolution. Neither acquisition type is available in sequence mode. ADC resolution is available on SDS2000X Plus models. Values adjusted by the scope are returned with a warning.

- Safety: Setup change
- Inputs:
  - `resolution` (optional): ADC resolution. Available on SDS2000X Plus models. Accepted values `"8Bits"`, `"10Bits"`.
  - `mode` (optional): Acquisition mode. YT plots amplitude over time, XY plots one channel against another and Roll draws slow signals from the right of the screen. Accepted values `"YT"`, `"XY"`, `"ROLL"`.
  - `capture_rate` (optional): Waveform capture rate. Fast favours signal anomalies and Slow is the ordinary rate. Accepted values `"FAST"`, `"SLOW"`.
  - `interpolation` (optional): Waveform interpolation. Sine uses sin(x)/x interpolation. Accepted values `"sine"`, `"linear"`.
  - `sequence` (optional): sequence mode, which records segments back to back.
  - `sequence_count` (optional): Number of memory segments to acquire. Memory depth and timebase may limit the accepted count. Minimum 1. Maximum 100000.
  - `acquisition_type` (optional): data acquisition type. Accepted values `"NORMal"`, `"PEAK"`, `"AVERage"`, `"ERES"`.
  - `average_count` (optional): Number of averages. Requires acquisition_type Average. Accepted values `4`, `16`, `32`, `64`, `128`, `256`, `512`, `1024`, `2048`, `4096`, `8192`.
  - `enhanced_bits` (optional): enhanced resolution bits, with acquisition_type ERES. Accepted values `0.5`, `1`, `1.5`, `2`, `2.5`, `3`, `3.5`, `4`.
  - `memory_management` (optional): Memory management strategy. Auto maximises sample rate, Fixed Sample Rate preserves sample_rate and Fixed Memory Depth preserves memory_depth. Accepted values `"AUTO"`, `"FSRate"`, `"FMDepth"`.
  - `memory_depth` (optional): Maximum memory depth. Available values vary by model, enabled channels and acquisition mode. 43 accepted values.
  - `sample_rate` (optional): Sampling rate in samples per second. Fixed Sample Rate memory management preserves this value. Unsupported rates are reduced to the nearest available value. Minimum 1. Maximum 1000000000000.

<a id="tool-en11f-clear-sweeps"></a>
### `clear_sweeps`

Clear the accumulated sweeps and restart the acquisition. Averaging, persistence, statistics and the acquisition count start over and cannot be restored. The command has no query form.

- Safety: Destructive
- Inputs: none

<a id="tool-en11f-get-timebase"></a>
### `get_timebase`

Read the horizontal reference, main scale, trigger delay and zoom window settings. Time values are returned in seconds.

- Safety: Read-only
- Inputs: none

<a id="tool-en11f-configure-timebase"></a>
### `configure_timebase`

Set the horizontal reference, main scale, trigger delay and zoom window settings, then read back the requested values. Values adjusted by the scope are returned with a warning.

- Safety: Setup change
- Inputs:
  - `reference` (optional): What stays fixed while the horizontal scale changes. Delay expands around the centre of the screen. Position expands around its grid position. Accepted values `"DELay"`, `"POSition"`.
  - `reference_position` (optional): Horizontal reference center in percent from 0 to 100. The Delay strategy expands around this point. Minimum 0. Maximum 100.
  - `time_per_div` (optional): Main horizontal scale in seconds per division. The range varies by model. Minimum 1e-12. Maximum 1000.
  - `trigger_delay` (optional): Seconds between the trigger and the reference point on screen. A negative value places the trigger before it. Minimum -1000. Maximum 1000.
  - `zoom_window` (optional): the zoomed window.
  - `zoom_scale` (optional): zoomed window scale in seconds per division, which the scope caps at the main scale. Minimum 1e-12. Maximum 1000.
  - `zoom_position` (optional): Position of the zoomed window inside the main sweep in seconds. An unsupported position is moved to the nearest valid value. Minimum -1000. Maximum 1000.

<a id="tool-en11f-get-channel"></a>
### `get_channel`

Read the configuration of one analog channel C1-C4, including its input, scaling, coupling, bandwidth, inversion, skew, label and visibility. Also returns the vertical reference shared by all channels.

- Safety: Read-only
- Inputs:
  - `source` (optional): Analog channel C1-C4. channel is accepted as an alias. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`.
  - `channel` (optional): Alias of source. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`.

<a id="tool-en11f-configure-channel"></a>
### `configure_channel`

Set one analog channel C1-C4 and read back the requested settings. Fifty Ohm impedance limits volts_per_div to less than 1 V. Values adjusted by the scope are returned with a warning.

- Safety: Setup change
- Inputs:
  - `source` (optional): Analog channel C1-C4. channel is accepted as an alias. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`.
  - `channel` (optional): Alias of source. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`.
  - `vertical_reference` (optional): What stays fixed while the vertical scale changes. Offset expands around the display X axis. Position expands around the ground marker. This setting is shared by every channel. Accepted values `"OFFSet"`, `"POSition"`.
  - `trace` (optional): the channel itself, the physical input switch.
  - `unit` (optional): unit of the input signal, which also relabels the measurements, the cursor values, the sensitivity and the trigger level. Accepted values `"V"`, `"A"`.
  - `impedance` (optional): Input impedance. One Megohm is 1 MOhm. Fifty Ohm limits volts_per_div to less than 1 V. Accepted values `"ONEMeg"`, `"FIFTy"`.
  - `probe_attenuation` (optional): Probe attenuation factor. It scales volts_per_div, offset, measurements and trigger levels without changing input sensitivity. Minimum 0.000001. Maximum 1000000.
  - `volts_per_div` (optional): Vertical sensitivity in volts per division, multiplied by probe_attenuation. Minimum 0.000001. Maximum 1000000.
  - `offset` (optional): vertical offset in volts, whose legal range follows volts_per_div. Minimum -1000000. Maximum 1000000.
  - `coupling` (optional): Input coupling: DC, AC or ground. Accepted values `"DC"`, `"AC"`, `"GND"`.
  - `bandwidth_limit` (optional): low-pass filter: FULL is the full bandwidth, 20M and 200M limit it to approximately that many hertz. Accepted values `"FULL"`, `"20M"`, `"200M"`.
  - `inverted` (optional): mathematical inversion of the trace, which does not change the polarity of the input against ground.
  - `skew` (optional): channel-to-channel skew in seconds, -100 ns to 100 ns. Minimum -1e-7. Maximum 1e-7.
  - `label_text` (optional): Label text, up to 20 characters. The scope stores labels in uppercase. Maximum length 20.
  - `label` (optional): the label on screen.
  - `visible` (optional): drawing the waveform, which leaves the channel switched on, unlike trace.

<a id="tool-en11f-get-digital"></a>
### `get_digital`

Read the digital function state, the active channel, waveform height and position, skew, per-line visibility and labels, the D0-D7 and D8-D15 thresholds and the two digital buses. The sample rate and points are read only while the digital function is on. Whether the MSO option is installed cannot be determined from the model identity.

- Safety: Read-only
- Inputs:
  - `lines` (required): Digital lines to read. Defaults to D0-D15. Default `["D0","D1","D2","D3","D4","D5","D6","D7","D8","D9","D10","D11","D12","D13","D14","D15"]`.

<a id="tool-en11f-configure-digital"></a>
### `configure_digital`

Turn the digital function on or off, select the active channel, show or hide lines D0-D15, label them, set the waveform height, position and skew, the D0-D7 and D8-D15 thresholds and the two digital buses, then read back the requested values. Whether the MSO option is installed cannot be determined from the model identity. Values the scope did not take are returned with a warning.

- Safety: Setup change
- Inputs:
  - `enabled` (optional): the digital function itself.
  - `active` (optional): the selected digital channel. 16 accepted values.
  - `lines` (optional): Display state per digital line, e.g. { D0: true, D8: false }.
  - `labels` (optional): Label text per digital line, up to 8 characters.
  - `height` (optional): height of the digital waveform in divisions, 4 to 8. Minimum 4. Maximum 8.
  - `position` (optional): Position of the digital waveform in divisions from the top of the waveform area. The legal range follows how many digital channels are displayed. Minimum -8. Maximum 8.
  - `skew` (optional): digital channel skew in seconds, -100 ns to 100 ns. Minimum -1e-7. Maximum 1e-7.
  - `thresholds` (optional): Thresholds of the D0-D7 and D8-D15 groups, e.g. { d0_d7: { mode: 'CMOS' } }.
  - `buses` (optional): The two digital buses, e.g. { bus1: { display: true, map: ['D0', 'D3'] } }.

<a id="tool-en11f-get-trigger"></a>
### `get_trigger`

Read the trigger mode, status, frequency, type and parameters for the active trigger type. Pattern and Delay per-source levels are not read back. SPI data patterns have no query form and are not returned.

- Safety: Read-only
- Inputs: none

<a id="tool-en11f-configure-trigger"></a>
### `configure_trigger`

Select a trigger type, set its parameters and read back the requested values. Each parameter must be supported by the selected type. Levels and time values adjusted by the scope are returned with a warning. Pattern and Delay channel levels and SPI data patterns are written but not read back. Optional trigger features return an availability warning. Use configure_trigger_mode to set the sweep mode or run and stop acquisition.

- Safety: Setup change
- Inputs:
  - `type` (required): Trigger type. The selected type determines which parameters apply. 24 accepted values.
  - `source` (optional): Trigger source. Supports channels C1-C4, digital channels D0-D15 on mixed-signal models, external inputs and line power. Available sources depend on the trigger type. 23 accepted values.
  - `impedance` (optional): External trigger input impedance. Applies only to EX and EX5 sources. Accepted values `"ONEMeg"`, `"FIFTy"`.
  - `slope` (optional): Trigger edge. Alternate switches between rising and falling edges. Interval and Dropout support only Rising or Falling. Accepted values `"RISing"`, `"FALLing"`, `"ALTernate"`.
  - `level` (optional): Trigger level in volts. The source scale and offset determine the available range. Minimum -1000000. Maximum 1000000.
  - `coupling` (optional): Trigger path coupling. DC passes the signal unchanged, AC blocks its DC offset, Low Frequency Reject reduces mains hum and High Frequency Reject reduces high-frequency noise. Accepted values `"DC"`, `"AC"`, `"LFREJect"`, `"HFREJect"`.
  - `noise_reject` (optional): noise rejection, a hysteresis band around the trigger level.
  - `holdoff_events` (optional): Trigger events counted before re-arming. Used by Events holdoff. Minimum 1. Maximum 100000000.
  - `holdoff_time` (optional): Seconds before the trigger re-arms. Used by Time holdoff. SHS models support a narrower range. Minimum 8e-9. Maximum 30.
  - `holdoff` (optional): Holdoff kind. Off re-arms immediately, Events waits for holdoff_events and Time waits for holdoff_time. Accepted values `"OFF"`, `"EVENts"`, `"TIME"`.
  - `holdoff_start` (optional): Where holdoff starts counting. Last Trigger starts at the previous trigger. Acquisition Start begins with acquisition. Accepted values `"LAST_TRIG"`, `"ACQ_START"`.
  - `level_high` (optional): Upper trigger level in volts. Must not be below level_low. Minimum -1000000. Maximum 1000000.
  - `level_low` (optional): Lower trigger level in volts. Must not be above level_high. Minimum -1000000. Maximum 1000000.
  - `limit` (optional): How measured time is compared. Less Than uses time_upper, Greater Than uses time_lower and Inner or Outer use both. Accepted values `"LESSthan"`, `"GREATerthan"`, `"INNer"`, `"OUTer"`.
  - `time_lower` (optional): Lower time bound in seconds. Used by Greater Than, Inner and Outer limits. Minimum 1e-9. Maximum 20.
  - `time_upper` (optional): Upper time bound in seconds. Used by Less Than, Inner and Outer limits. Minimum 1e-9. Maximum 20.
  - `polarity` (optional): pulse polarity the scope triggers on: POSitive or NEGative. Accepted values `"POSitive"`, `"NEGative"`.
  - `window_type` (optional): How the trigger window is defined. Absolute uses level_high and level_low. Relative uses center_level and delta_level. Accepted values `"ABSolute"`, `"RELative"`.
  - `center_level` (optional): Center of the window in volts. Requires window_type Relative. Minimum -1000000. Maximum 1000000.
  - `delta_level` (optional): Half-height of the window in volts on either side of center_level. Requires window_type Relative. Minimum -1000000. Maximum 1000000.
  - `dropout_type` (optional): Dropout kind. Edge triggers when no edge arrives within dropout_time. State triggers when the signal stays at the level for that time. Accepted values `"EDGE"`, `"STATe"`.
  - `dropout_time` (optional): dropout time in seconds. Minimum 1e-9. Maximum 20.
  - `standard` (optional): Video standard. The selected standard determines which video parameters apply. Accepted values `"NTSC"`, `"PAL"`, `"P720L50"`, `"P720L60"`, `"P1080L50"`, `"P1080L60"`, `"I1080L50"`, `"I1080L60"`, `"CUSTom"`.
  - `frame_rate` (optional): frame rate of the custom standard: 25Hz, 30Hz, 50Hz or 60Hz. Accepted values `"25Hz"`, `"30Hz"`, `"50Hz"`, `"60Hz"`.
  - `line_count` (optional): lines of the custom standard, 300 to 2000. Minimum 300. Maximum 2000.
  - `field_count` (optional): fields of the custom standard: 1, 2, 4 or 8. Accepted values `1`, `2`, `4`, `8`.
  - `interlace` (optional): interlace of the custom standard: 1, 2, 4 or 8 to one. Accepted values `1`, `2`, `4`, `8`.
  - `sync` (optional): Sync mode. Select uses the configured line and field. Any triggers on any sync pulse. Accepted values `"SELect"`, `"ANY"`.
  - `field` (optional): Synchronous trigger field 1 or 2. Available for interlaced video standards. Accepted values `1`, `2`.
  - `line` (optional): Synchronous trigger line. The valid range depends on the video standard and field and is checked by the scope. Minimum 1. Maximum 1125.
  - `pattern` (optional): State tested for each source, ordered C1-C4 then D0-D15. H is high, L is low and X is either.
  - `channel_level` (optional): Trigger level of one analog source in volts. This value is written but not read back.
  - `logic` (optional): Boolean combination of source states. Time limits apply only to And and Nor. Accepted values `"AND"`, `"OR"`, `"NAND"`, `"NOR"`.
  - `edge_source` (optional): edge source of the qualified trigger: an analog channel C1-C4 or a digital channel D0-D15. 20 accepted values.
  - `edge_level` (optional): trigger level of the edge source in volts. Minimum -1000000. Maximum 1000000.
  - `edge_slope` (optional): Rising or falling edge of the edge source. Accepted values `"RISing"`, `"FALLing"`.
  - `qualify_source` (optional): qualify source of the qualified trigger: an analog channel C1-C4 or a digital channel D0-D15. 20 accepted values.
  - `qualify_level` (optional): level of the qualify source in volts. Minimum -1000000. Maximum 1000000.
  - `qualified_type` (optional): Condition applied to the qualify source. State conditions use Low or High. Edge conditions use Rising or Falling. Time limits apply to delayed conditions.
  - `source2` (optional): source B of the delay trigger: an analog channel C1-C4 or a digital channel D0-D15. 20 accepted values.
  - `level2` (optional): trigger level of source B in volts. Minimum -1000000. Maximum 1000000.
  - `slope2` (optional): Rising or falling edge of source B. Accepted values `"RISing"`, `"FALLing"`.
  - `idle_time` (optional): idle time in seconds the signal must rest before the edges are counted, 8 ns to 20 s. Minimum 8e-9. Maximum 20.
  - `edge_count` (optional): edge counted from the end of the idle time, 1 to 65535. Minimum 1. Maximum 65535.
  - `clock_source` (optional): Clock line. Use an analog channel C1-C4 or digital channel D0-D15. 20 accepted values.
  - `clock_threshold` (optional): threshold of the clock source in volts. Minimum -1000000. Maximum 1000000.
  - `data_source` (optional): Data line. Use an analog channel C1-C4 or digital channel D0-D15. 20 accepted values.
  - `data_threshold` (optional): threshold of the data source in volts. Minimum -1000000. Maximum 1000000.
  - `data_state` (optional): level the data source is tested for: LOW or HIGH. Accepted values `"LOW"`, `"HIGH"`.
  - `setup_hold` (optional): What the time bounds measure. Setup measures before the clock edge. Hold measures after it. Accepted values `"SETup"`, `"HOLD"`.
  - `address_length` (optional): length of the IIC address: 7BIT or 10BIT. Accepted values `"7BIT"`, `"10BIT"`.
  - `data_length` (optional): Length matched by the trigger. The unit and range depend on the selected protocol.
  - `condition` (optional): Bus condition to trigger on. Available conditions depend on the selected protocol. SPI uses data pattern instead. 23 accepted values.
  - `address` (optional): IIC address the trigger matches, 0 to 127. Minimum 0. Maximum 127.
  - `direction` (optional): IIC frame direction. Applies to 7-bit and 10-bit address conditions. Accepted values `"WRITe"`, `"READ"`, `"ANY"`.
  - `compare` (optional): How the value is compared. Available comparisons depend on the selected protocol and condition. Accepted values `"EQUal"`, `"GREaterthan"`, `"LESSthan"`, `"ANY"`.
  - `data` (optional): Data value matched by the bus trigger. The allowed range depends on the protocol and data length. The maximum schema value means any value. Minimum 0. Maximum 256.
  - `data2` (optional): second Data value matched by the bus trigger. The allowed range depends on the protocol and data length. The maximum schema value means any value. Minimum 0. Maximum 256.
  - `mosi_source` (optional): SPI MOSI line: an analog channel C1-C4 or a digital channel D0-D15. 20 accepted values.
  - `mosi_threshold` (optional): threshold of the SPI MOSI line in volts. Minimum -1000000. Maximum 1000000.
  - `miso_source` (optional): SPI MISO line: an analog channel C1-C4 or a digital channel D0-D15. 20 accepted values.
  - `miso_threshold` (optional): threshold of the SPI MISO line in volts. Minimum -1000000. Maximum 1000000.
  - `cs_source` (optional): SPI CS line: an analog channel C1-C4 or a digital channel D0-D15. 20 accepted values.
  - `cs_threshold` (optional): threshold of the SPI CS line in volts. Minimum -1000000. Maximum 1000000.
  - `ncs_source` (optional): SPI ~CS line: an analog channel C1-C4 or a digital channel D0-D15. 20 accepted values.
  - `ncs_threshold` (optional): threshold of the SPI ~CS line in volts. Minimum -1000000. Maximum 1000000.
  - `cs_type` (optional): SPI chip selection. CS uses chip select, NCS uses its inverse and Timeout uses a clock-idle duration.
  - `latch_edge` (optional): Rising or falling clock edge used to sample data. Accepted values `"RISing"`, `"FALLing"`.
  - `bit_order` (optional): Bit order. MSB reads the most significant bit first. LSB reads the least significant bit first. Accepted values `"LSM"`, `"MSB"`.
  - `trigger_on` (optional): line the data is matched on: MISO or MOSI for SPI, RX or TX for UART. Accepted values `"MISO"`, `"MOSI"`, `"RX"`, `"TX"`.
  - `data_pattern` (optional): SPI data pattern with one entry per bit. Use 0, 1 or X for either. The array length must match data_length. The command has no query form.
  - `rx_source` (optional): UART RX line: an analog channel C1-C4 or a digital channel D0-D15. 20 accepted values.
  - `rx_threshold` (optional): threshold of the UART RX line in volts. Minimum -1000000. Maximum 1000000.
  - `tx_source` (optional): UART TX line: an analog channel C1-C4 or a digital channel D0-D15. 20 accepted values.
  - `tx_threshold` (optional): threshold of the UART TX line in volts. Minimum -1000000. Maximum 1000000.
  - `baud` (optional): Baud rate preset or custom rate in bits per second. The accepted range depends on the selected protocol.
  - `parity` (optional): UART parity: NONE, ODD, EVEN, MARK or SPACe. Accepted values `"NONE"`, `"ODD"`, `"EVEN"`, `"MARK"`, `"SPACe"`.
  - `stop_bits` (optional): length of the UART stop bit: 1, 1.5 or 2 bit times. Accepted values `1`, `1.5`, `2`.
  - `idle_level` (optional): idle level of the line: LOW or HIGH. Accepted values `"LOW"`, `"HIGH"`.
  - `threshold` (optional): threshold of the trigger source in volts. Minimum -1000000. Maximum 1000000.
  - `id_length` (optional): length of the CAN and CAN FD identifier: 11BITS or 29BITS. Accepted values `"11BITS"`, `"29BITS"`.
  - `id` (optional): Frame identifier. The allowed range depends on the selected protocol and identifier length. The maximum schema value means any identifier.
  - `data_baud` (optional): CAN FD data-phase baud rate. Applies to Both and CAN FD frame types.
  - `frame_type` (optional): CAN FD frame type. The selection determines whether data_baud applies. Accepted values `"BOTH"`, `"CAN"`, `"CANFd"`.
  - `checksum_error` (optional): whether the LIN error trigger takes a checksum error, which is what lin_standard, error_id and data_length describe.
  - `parity_error` (optional): whether the LIN error trigger takes a header parity error.
  - `sync_error` (optional): whether the LIN error trigger takes a sync byte error.
  - `lin_standard` (optional): LIN protocol revision used for the checksum. Zero is revision 1.3 and one is revision 2.x. Accepted values `0`, `1`.
  - `error_id` (optional): identifier of the LIN error frame, 0 to 63. Minimum 0. Maximum 63.
  - `frame_cycle` (optional): FlexRay frame cycle, 0 to 63. Minimum 0. Maximum 63.
  - `repetition` (optional): FlexRay cycle repetition. Applies to Equal cycle comparison. Accepted values `1`, `2`, `4`, `8`, `16`, `32`, `64`.
  - `ws_source` (optional): IIS word select line: an analog channel C1-C4 or a digital channel D0-D15. 20 accepted values.
  - `ws_threshold` (optional): threshold of the IIS word select line in volts. Minimum -1000000. Maximum 1000000.
  - `audio_variant` (optional): IIS audio variant. LJ is left justified and RJ is right justified. Accepted values `"IIS"`, `"LJ"`, `"RJ"`.
  - `left_level` (optional): level of the IIS word select line that marks the left channel: LOW or HIGH. Accepted values `"LOW"`, `"HIGH"`.
  - `audio_channel` (optional): IIS channel the trigger takes: LEFT or RIGHT. Accepted values `"LEFT"`, `"RIGHT"`.
  - `value` (optional): IIS data value to compare. The range follows data_length. The maximum schema value means any value. Minimum 0. Maximum 4294967296.

<a id="tool-en11f-configure-trigger-mode"></a>
### `configure_trigger_mode`

Set the trigger sweep mode and optionally run or stop acquisition, then read the resulting mode and status. Auto triggers when no condition is met, Normal waits for one, Single stops after the first and Force Trigger captures one frame immediately. Run and stop have no query form. Force Trigger read-back is not verified on hardware.

- Safety: Setup change
- Inputs:
  - `mode` (optional): Sweep mode. Auto triggers when no condition is met, Normal waits for one, Single stops after the first and Force Trigger captures one frame immediately. Accepted values `"AUTO"`, `"NORMal"`, `"SINGle"`, `"FTRIG"`.
  - `action` (optional): Run or stop acquisition after applying the mode. Accepted values `"run"`, `"stop"`.

<a id="tool-en11f-get-search"></a>
### `get_search`

Read whether the search function is on, which search mode is selected and the parameters of that mode. Parameters of the other modes are left unread. Use read_search_events for the events the current screen holds.

- Safety: Read-only
- Inputs: none

<a id="tool-en11f-configure-search"></a>
### `configure_search`

Turn the search function on or off, select a search mode, set its parameters and read back the requested values. Each parameter must be supported by the selected mode. Levels and time values adjusted by the scope are returned with a warning. Searching does not change what the scope acquires. It marks the events it finds on the waveform already captured.

- Safety: Setup change
- Inputs:
  - `search` (optional): Whether the search function is on.
  - `mode` (optional): Search mode. The selected mode determines which parameters apply. Accepted values `"EDGE"`, `"SLOPe"`, `"PULSE"`, `"INTerval"`, `"RUNT"`.
  - `source` (optional): Search source. Use an analog channel C1-C4 or a digital channel D0-D15 on mixed-signal models. 20 accepted values.
  - `slope` (optional): Search edge. Alternate takes rising and falling edges in turn. Interval supports only Rising or Falling. Accepted values `"RISing"`, `"FALLing"`, `"ALTernate"`.
  - `level` (optional): Search level in volts. The source scale and offset determine the available range. Minimum -1000000. Maximum 1000000.
  - `level_high` (optional): Upper search level in volts. Must not be below level_low. Minimum -1000000. Maximum 1000000.
  - `level_low` (optional): Lower search level in volts. Must not be above level_high. Minimum -1000000. Maximum 1000000.
  - `limit` (optional): How measured time is compared. Less Than uses time_upper, Greater Than uses time_lower and Inner or Outer use both. Accepted values `"LESSthan"`, `"GREATerthan"`, `"INNer"`, `"OUTer"`.
  - `time_lower` (optional): Lower time bound in seconds. Used by Greater Than, Inner and Outer limits. Minimum 1e-9. Maximum 20.
  - `time_upper` (optional): Upper time bound in seconds. Used by Less Than, Inner and Outer limits. Minimum 1e-9. Maximum 20.
  - `polarity` (optional): pulse polarity the search takes: POSitive or NEGative. Accepted values `"POSitive"`, `"NEGative"`.

<a id="tool-en11f-read-search-events"></a>
### `read_search_events`

Read how many search events the current screen holds and the index of the event in its center. The search function is read first and neither count is asked for while it is off, because a search that is off marks nothing. The centered index is documented for a stopped acquisition.

- Safety: Read-only
- Inputs: none

<a id="tool-en11f-copy-search-settings"></a>
### `copy_search_settings`

Copy the settings between the search and the trigger. From Trigger overwrites the search settings with the trigger ones, To Trigger overwrites the trigger settings with the search ones and Cancel undoes the last of the two. The overwritten settings are not saved anywhere and the command has no query form.

- Safety: Destructive
- Inputs:
  - `direction` (required): From Trigger copies the trigger setup into the search, To Trigger copies the search setup into the trigger and Cancel undoes the last copy. Accepted values `"FROMtrigger"`, `"TOTRigger"`, `"CANCel"`.

<a id="tool-en11f-get-waveform"></a>
### `get_waveform`

Transfer an analog waveform and return time and voltage values with summary statistics. Annotated destructive because on an SDS1204X HD with firmware 6.9.13.1.1.6.7 full record decimated transfers were followed three times by an acquisition state that only a power cycle cleared, so --disable-destructive-commands hides this tool until that behaviour is understood. The transfer is limited to 64 MiB and 64 pieces. Point output is reduced to at most 4096 values and CSV output to 200000 values. points defaults to 1000. Set points to 0 for the full record and use interval to reduce data at the scope. Samples are decoded with the width the descriptor reports, and a scope that keeps another width than the requested one raises a warning. The scaling result names the transferred sample width and the known ADC resolution separately, because the descriptor reports the container width rather than the converter. This changes the retained waveform transfer settings. Waveform traffic engages the front-panel remote lock on some firmware, so the lock is released after the transfer unless the server runs with the enable-lock flag. A math source F1-F4 is transferred after its function answers ON and refused with a warning while it is off, and its values come back in the unit of the trace. Digital sources are not supported.

- Safety: Destructive
- Inputs:
  - `source` (optional): Analog channel C1-C4 or math function F1-F4. channel is accepted as an alias. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`, `"F1"`, `"F2"`, `"F3"`, `"F4"`.
  - `channel` (optional): Alias of source. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`, `"F1"`, `"F2"`, `"F3"`, `"F4"`.
  - `first_point` (required): Index of the first point to transfer. Zero is the first acquired point. Default `0`. Minimum 0. Maximum 200000000.
  - `points` (required): Number of points to transfer. Zero transfers the whole record. Default `1000`. Minimum 0. Maximum 200000000.
  - `interval` (required): Spacing between transferred points. One transfers every point. Default `1`. Minimum 1. Maximum 1000000.
  - `frame` (optional): Sequence frame index, valid while sequence mode is on. Zero transfers as many frames as fit in one response. Minimum 0. Maximum 100000.
  - `frame_start` (optional): First sequence frame of the slice. Requires frame to be zero. Minimum 1. Maximum 100000.
  - `output` (required): points returns the series inline, summary only the statistics, csv attaches it as a text/csv resource. Accepted values `"points"`, `"summary"`, `"csv"`. Default `"points"`.
  - `horizontal_divisions` (optional): Grid divisions across the screen, used to calculate the time of the first point. Defaults to 10 for SDS models and 12 for SHS models. Minimum 1. Maximum 20.
  - `timeout_ms` (optional): Timeout of one transfer in milliseconds, default 30000. Minimum 100. Maximum 120000.

<a id="tool-en11f-get-math"></a>
### `get_math`

Read one math function F1-F4: switch, operation, sources, the settings of the active operation, vertical scale and position, inversion and label. FFT settings are read with get_fft.

- Safety: Read-only
- Inputs:
  - `function` (required): Math function trace, 1 for F1 to 4 for F4. Model-specific limits are unknown, so four is the validation cap. Default `1`. Minimum 1. Maximum 4.

<a id="tool-en11f-configure-math"></a>
### `configure_math`

Set one math function F1-F4 and read back the requested settings. Operation-specific settings need their operation in the same request. FFT settings are configured with configure_fft. Values adjusted by the scope are returned with a warning.

- Safety: Setup change
- Inputs:
  - `function` (required): Math function trace, 1 for F1 to 4 for F4. Model-specific limits are unknown, so four is the validation cap. Default `1`. Minimum 1. Maximum 4.
  - `enabled` (optional): the math function itself.
  - `operation` (optional): The waveform math operation. FFT settings live in get_fft and configure_fft. 22 accepted values.
  - `source1` (optional): First operand: an analog channel, a zoomed trace, another math function or a memory waveform. 16 accepted values.
  - `source2` (optional): Second operand, used by the two-source arithmetic operations: an analog channel, a zoomed trace, another math function or a memory waveform. 16 accepted values.
  - `average_count` (optional): Sweeps of the Average operation. The SDS800X HD, SDS1000X HD and SDS2000X Plus stop at 1024. Accepted values `4`, `16`, `32`, `64`, `128`, `256`, `512`, `1024`, `2048`, `4096`, `8192`.
  - `diff_dx` (optional): Step size of the Diff operation in samples. The accepted range is unknown. Minimum 1. Maximum 1000000.
  - `eres_bits` (optional): Enhancement of the Eres operation in bits. Accepted values `0.5`, `1`, `1.5`, `2`, `2.5`, `3`.
  - `filter_type` (optional): Filter operation type: low pass, high pass, band pass or band reject. Accepted values `"LPASs"`, `"HPASs"`, `"BPASs"`, `"BREJect"`.
  - `filter_upper` (optional): Upper filter frequency in hertz. Used only by band pass and band reject. Minimum 0. Maximum 10000000000.
  - `filter_lower` (optional): Lower filter frequency in hertz. Minimum 0. Maximum 10000000000.
  - `integrate_gate` (optional): the integration threshold gates positioned by gate_a and gate_b.
  - `integrate_offset` (optional): DC offset of the Integrate operation, -1.67 to 1.67. Minimum -1.67. Maximum 1.67.
  - `interpolate_factor` (optional): upsample factor of the Interpolate operation. Accepted values `2`, `5`, `10`, `20`.
  - `maxhold_sweeps` (optional): sweeps limit of the Maxhold operation. Minimum 1. Maximum 2147483646.
  - `minhold_sweeps` (optional): sweeps limit of the Minhold operation. Minimum 1. Maximum 2147483646.
  - `inverted` (optional): inversion of the math waveform.
  - `scale` (optional): Vertical scale per division of the math trace, whose range follows the source scale, and the time base for Integrate and Diff. Minimum -1000000000000. Maximum 1000000000000.
  - `position` (optional): vertical position of the math trace in its own unit. Minimum -1000000000000. Maximum 1000000000000.
  - `label_text` (optional): label text, up to 20 characters. Maximum length 20.
  - `label` (optional): the label on screen.
  - `gate_a` (optional): Position of integration gate A in seconds. Set with gate_b and never above it. Minimum -10000. Maximum 10000.
  - `gate_b` (optional): position of integration gate B in seconds. Minimum -10000. Maximum 10000.

<a id="tool-en11f-get-fft"></a>
### `get_fft`

Read the FFT of one math function F1-F4: display mode, source, unit, window, acquisition mode, points, span, center frequency, horizontal and vertical scale, reference level, external load and search settings. The stored settings are returned even while the operation is not FFT.

- Safety: Read-only
- Inputs:
  - `function` (required): Math function trace, 1 for F1 to 4 for F4. Model-specific limits are unknown, so four is the validation cap. Default `1`. Minimum 1. Maximum 4.

<a id="tool-en11f-configure-fft"></a>
### `configure_fft`

Configure the FFT of one math function F1-F4 and read back the requested settings. Providing a source switches the operation of the function to FFT. Without a source, a function running another operation stores the settings and raises a warning. Scale, reference level, excursion, and threshold use the selected FFT unit. Values adjusted by the scope are returned with a warning.

- Safety: Setup change
- Inputs:
  - `function` (required): Math function trace, 1 for F1 to 4 for F4. Model-specific limits are unknown, so four is the validation cap. Default `1`. Minimum 1. Maximum 4.
  - `enabled` (optional): the math function itself.
  - `source` (optional): FFT source. Providing it switches the operation of the function to FFT. 16 accepted values.
  - `display` (optional): How the FFT shares the screen with the source trace: split, full screen or exclusive. This setting is shared by every function. Accepted values `"SPLit"`, `"FULL"`, `"EXCLusive"`.
  - `unit` (optional): Vertical unit of the FFT trace. The scale, reference level and search values follow it. Accepted values `"DBVrms"`, `"Vrms"`, `"DBm"`.
  - `load` (optional): External load in ohm the dBm unit converts power against. The scope takes it only while the unit is dBm. Minimum 1. Maximum 1000000.
  - `window` (optional): Window function. Rectangle suits transients, Blackman small impulses, Hanning frequency resolution, Flattop amplitude accuracy. Accepted values `"RECTangle"`, `"BLACkman"`, `"HANNing"`, `"HAMMing"`, `"FLATtop"`.
  - `points` (optional): Maximum FFT points. The set varies by model and ends at 2M on the SDS800X HD class. 16 accepted values.
  - `span` (optional): horizontal span of the FFT in hertz. Minimum 0. Maximum 10000000000.
  - `center_frequency` (optional): Center frequency of the FFT in hertz, whose legal range follows the time base. Minimum 0. Maximum 10000000000.
  - `vertical_scale` (optional): Vertical scale per division in the FFT unit: 0.1 to 20 for dBVrms and dBm, 0.001 to 10 for Vrms. Minimum 0.001. Maximum 20.
  - `reference_level` (optional): Reference level at the top of the FFT grid in the FFT unit, whose range follows the unit and the probe factor. Minimum -280. Maximum 10000000000.
  - `search` (optional): The FFT search tool: off, a peak table or markers. Accepted values `"OFF"`, `"PEAK"`, `"MARKer"`.
  - `search_excursion` (optional): minimum rise and fall around a found peak, in the FFT unit. Minimum 0. Maximum 10000000000.
  - `search_threshold` (optional): minimum level a peak must reach, in the FFT unit. Minimum -280. Maximum 10000000000.
  - `mode` (optional): FFT acquisition: normal, max hold or averaging. Accepted values `"NORMal"`, `"MAXHold"`, `"AVERage"`.
  - `average_count` (optional): Averaging sweeps, 4 to 1024. Requires mode AVERage. Minimum 4. Maximum 1024.

<a id="tool-en11f-autoset-fft"></a>
### `autoset_fft`

Place the FFT of one math function at the best position on screen: SPAN spreads the full span, PEAK centers the highest peak, NORMal centers the fundamental with half the FFT sample rate as span. Returns the resulting span, center, scale and reference level.

- Safety: Setup change
- Inputs:
  - `function` (required): Math function trace, 1 for F1 to 4 for F4. Model-specific limits are unknown, so four is the validation cap. Default `1`. Minimum 1. Maximum 4.
  - `mode` (required): SPAN for full span, PEAK to center the peak, NORMal to center the fundamental. Accepted values `"SPAN"`, `"PEAK"`, `"NORMal"`.

<a id="tool-en11f-reset-fft"></a>
### `reset_fft`

Restart the FFT average counting of one math function. Meaningful in the AVERage acquisition mode, whose accumulated average is discarded and cannot be restored. Another mode raises a warning and the reset is still sent.

- Safety: Destructive
- Inputs:
  - `function` (required): Math function trace, 1 for F1 to 4 for F4. Model-specific limits are unknown, so four is the validation cap. Default `1`. Minimum 1. Maximum 4.

<a id="tool-en11f-read-fft-peaks"></a>
### `read_fft_peaks`

Read the FFT search table of one math function: peak or marker numbers, frequencies in hertz and amplitudes in the FFT unit. The search tool must be on. A search that is off returns a warning and no table.

- Safety: Read-only
- Inputs:
  - `function` (required): Math function trace, 1 for F1 to 4 for F4. Model-specific limits are unknown, so four is the validation cap. Default `1`. Minimum 1. Maximum 4.

<a id="tool-en11f-get-measurement-setup"></a>
### `get_measurement_setup`

Read the measurement mode, simple source, advanced display settings, amplitude strategy and threshold settings. Use get_measurement_gate for the gate, get_measurement_statistics for statistics and list_measurements for advanced items.

- Safety: Read-only
- Inputs: none

<a id="tool-en11f-configure-measurement-setup"></a>
### `configure_measurement_setup`

Set the measurement mode, simple source, advanced display settings, amplitude strategy and threshold settings, then read back the requested values. Threshold levels must be ordered from high to middle to low.

- Safety: Setup change
- Inputs:
  - `measurement` (optional): the measurement function itself.
  - `mode` (optional): Simple shows measurements. Advanced adds statistics, display styles, histograms and trending. Accepted values `"SIMPle"`, `"ADVanced"`.
  - `simple_source` (optional): the trace every simple measurement item is taken from. 52 accepted values.
  - `advanced_items` (optional): how many of the twelve advanced measurement items are displayed, 1 to 12. Minimum 1. Maximum 12.
  - `advanced_style` (optional): M1 lists a measurement, statistics and histogram vertically. M2 lists a measurement and statistics horizontally without a histogram. Accepted values `"M1"`, `"M2"`.
  - `amplitude_strategy` (optional): How top and base are found. Auto derives them from the signal. Manual uses amplitude_top and amplitude_base. Accepted values `"AUTO"`, `"MANual"`.
  - `amplitude_top` (optional): Histogram uses the most probable value as the top. Max uses the largest waveform value. Accepted values `"HISTogram"`, `"MAX"`.
  - `amplitude_base` (optional): Histogram uses the most probable value as the base. Min uses the smallest waveform value. Accepted values `"HISTogram"`, `"MIN"`.
  - `threshold_source` (optional): Trace whose reference levels are used. Digital sources are not supported. 20 accepted values.
  - `threshold_type` (optional): Percent uses threshold_percent. Absolute uses threshold_absolute. Accepted values `"PERCent"`, `"ABSolute"`.
  - `threshold_absolute` (optional): Upper, middle and lower reference levels in volts. Used when threshold_type is Absolute.
  - `threshold_percent` (optional): Upper, middle and lower reference levels as percentages of amplitude. Used when threshold_type is Percent.

<a id="tool-en11f-get-measurement-gate"></a>
### `get_measurement_gate`

Read whether the measurement gate is enabled and both gate positions in seconds from the trigger.

- Safety: Read-only
- Inputs: none

<a id="tool-en11f-configure-measurement-gate"></a>
### `configure_measurement_gate`

Turn the measurement gate on or off and set its two positions, then read back the requested values. Only the waveform between gate A and gate B is measured. Positions are in seconds from the trigger and may be adjusted to fit the timebase.

- Safety: Setup change
- Inputs:
  - `enabled` (optional): the measurement gate: only what lies between gate A and gate B is measured.
  - `gate_a` (optional): left gate position in seconds from the trigger. Minimum -10000. Maximum 10000.
  - `gate_b` (optional): right gate position in seconds, never before gate A. Minimum -10000. Maximum 10000.

<a id="tool-en11f-get-measurement-statistics"></a>
### `get_measurement_statistics`

Read advanced measurement statistics and their histogram, count limits, sources and current values. Statistics include current, mean, maximum, minimum, standard deviation and count. Select an item from 1 to 12 or read every displayed item. When statistics are off, no item statistics are read and a warning is returned.

- Safety: Read-only
- Inputs:
  - `item` (optional): Read one advanced item 1-12 instead of every displayed one. Minimum 1. Maximum 12.
  - `statistic` (required): Statistic to read, or All for the complete set. Accepted values `"ALL"`, `"CURRent"`, `"MEAN"`, `"MAXimum"`, `"MINimum"`, `"STDev"`, `"COUNt"`. Default `"ALL"`.

<a id="tool-en11f-configure-measurement-statistics"></a>
### `configure_measurement_statistics`

Turn advanced measurement statistics on or off, configure the histogram and count limits, and optionally restart accumulation. A maximum count of zero is unlimited. Reset has no query form. Statistics require Advanced measurement mode.

- Safety: Destructive
- Inputs:
  - `statistics` (optional): the statistics of the advanced measurements.
  - `histogram` (optional): the histogram, which the M1 style shows.
  - `max_count` (optional): Number of measurements included in statistics, 0 to 1024. Zero means unlimited. Minimum 0. Maximum 1024.
  - `aim_limit` (optional): Statistics AIM limit. Minimum 0. Maximum 1000000.
  - `reset` (optional): Discard accumulated statistics and start over. The command has no query form. Required value `true`.

<a id="tool-en11f-measure"></a>
### `measure`

Install one or more simple measurements on a trace and read their values. This enables measurements, selects Simple mode and changes the scope display. Use configure_advanced_measurement or measure_delay for two-source measurements. Values the scope cannot measure are preserved as raw text with a warning. RISE20T80 and FALL80T20 are refused because their value query never answers on hardware. Use configure_advanced_measurement with RISE10T90 or FALL90T10 for the same transition time.

- Safety: Setup change
- Inputs:
  - `source` (optional): Trace to measure. channel is accepted as an alias. 52 accepted values.
  - `channel` (optional): Alias of source. 52 accepted values.
  - `parameter` (optional): One measurement type. 50 accepted values.
  - `parameters` (optional): Several types.

<a id="tool-en11f-read-measurement"></a>
### `read_measurement`

Read simple measurement values without installing them. A measurement that is not installed may return raw placeholder text with a warning. All returns installed simple measurements as a list whose order is not known. Use measure to install measurements first. RISE20T80 and FALL80T20 are refused because their value query never answers on hardware. Use configure_advanced_measurement with RISE10T90 or FALL90T10 for the same transition time.

- Safety: Read-only
- Inputs:
  - `parameter` (optional): One measurement type. 51 accepted values.
  - `parameters` (optional): Several measurement types.

<a id="tool-en11f-list-measurements"></a>
### `list_measurements`

List advanced measurement items P1-P12 with their enabled state, type, sources and current value. Select one item or read every displayed item. Use get_measurement_statistics for accumulated statistics.

- Safety: Read-only
- Inputs:
  - `item` (optional): Read one advanced item 1-12 instead of every displayed one. Minimum 1. Maximum 12.

<a id="tool-en11f-configure-advanced-measurement"></a>
### `configure_advanced_measurement`

Place an advanced measurement in display slot 1-12 and read it back. This enables measurements and selects Advanced mode. source2 applies only to two-source measurement types, which require analog channels C1-C4. Support for other sources cannot be determined before use.

- Safety: Setup change
- Inputs:
  - `item` (required): Display slot 1-12 for the measurement. Minimum 1. Maximum 12.
  - `enabled` (optional): the measurement item itself, at its place on the display.
  - `type` (optional): what the item measures. 66 accepted values.
  - `source1` (optional): the trace the item is taken from. 52 accepted values.
  - `source2` (optional): Second trace for a two-source measurement type. 52 accepted values.

<a id="tool-en11f-measure-delay"></a>
### `measure_delay`

Install a delay measurement between two analog channels C1-C4 in advanced slot 1-12 and read its value. Phase is returned in degrees. Other delay types are returned as time values.

- Safety: Setup change
- Inputs:
  - `source_a` (required): First source of the pair. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`.
  - `source_b` (required): Second source of the pair. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`.
  - `type` (required): Delay type. Phase returns a difference in degrees. Accepted values `"PHA"`, `"SKEW"`, `"FRR"`, `"FRF"`, `"FFR"`, `"FFF"`, `"LRR"`, `"LRF"`, `"LFR"`, `"LFF"`.
  - `item` (required): Display slot 1-12 for the measurement. Default `1`. Minimum 1. Maximum 12.

<a id="tool-en11f-clear-measurements"></a>
### `clear_measurements`

Remove installed simple measurements, advanced measurements or both. This cannot be undone and has no query form. The measurement function remains enabled.

- Safety: Destructive
- Inputs:
  - `items` (required): Set of measurement items to clear. All clears both sets. Accepted values `"simple"`, `"advanced"`, `"all"`. Default `"all"`.

<a id="tool-en11f-get-cursors"></a>
### `get_cursors`

Read the cursor mode, style, sources, expansion settings and X/Y positions in seconds and volts. Measurement items are included in Measure mode. The second cursor source is read in Track mode only, because its query does not answer in the other modes. Use measure_cursors for deltas and reciprocal frequency.

- Safety: Read-only
- Inputs: none

<a id="tool-en11f-configure-cursors"></a>
### `configure_cursors`

Set the cursor mode, measurement item, style, sources, expansion settings and X/Y positions, then read back the requested values. Manual type applies only to Manual mode. source2 applies only to two-source measurement types. Track mode does not support Digital or Histogram sources. The second cursor source is written in every mode and read back in Track mode only, because its query does not answer in the other modes. Positions adjusted by the scope are returned with a warning. Support for non-analog sources cannot be determined before use.

- Safety: Setup change
- Inputs:
  - `cursors` (optional): the cursor function itself.
  - `mode` (optional): Manual places both cursors by hand. Track ties them to the source waveforms. Measure ties them to the advanced measurement named by measure_item. Accepted values `"TRACk"`, `"MANual"`, `"MEASure"`.
  - `manual_type` (optional): Which manual cursors are shown. X selects the two vertical cursors, Y selects the two horizontal cursors and XY selects all four. Requires Manual mode. Accepted values `"X"`, `"Y"`, `"XY"`.
  - `measure_item` (optional): Advanced measurement used by Measure mode. source2 applies only to two-source measurement types.
  - `tag_style` (optional): Where cursor value tags are drawn. Fixed keeps them in place and Following moves them with the trace. Accepted values `"FIXed"`, `"FOLLowing"`.
  - `source1` (optional): the trace cursor 1 belongs to. 22 accepted values.
  - `source2` (optional): Trace cursor 2 belongs to. Read back in Track mode only. 22 accepted values.
  - `x_reference` (optional): What stays fixed while the timebase changes. Delay keeps the cursor value, so the cursor moves on screen. Position keeps the cursor in place while the waveform expands around it. Accepted values `"DELay"`, `"POSition"`.
  - `y_reference` (optional): What stays fixed while the vertical scale changes. Offset keeps the cursor value, so the cursor moves on screen. Position keeps the cursor in place. Accepted values `"OFFSet"`, `"POSition"`.
  - `x1` (optional): position of cursor X1 in seconds from the trigger. Minimum -10000. Maximum 10000.
  - `x2` (optional): position of cursor X2 in seconds from the trigger. Minimum -10000. Maximum 10000.
  - `y1` (optional): position of cursor Y1 in volts. Minimum -1000000. Maximum 1000000.
  - `y2` (optional): position of cursor Y2 in volts. Minimum -1000000. Maximum 1000000.

<a id="tool-en11f-measure-cursors"></a>
### `measure_cursors`

Read both cursor positions, their horizontal and vertical differences and the reciprocal horizontal difference. Also returns the cursor mode and sources. The second cursor source is read in Track mode only, because its query does not answer in the other modes. Nonnumeric values are preserved as raw text. Cursors that are off or hidden by the current manual mode return a warning.

- Safety: Read-only
- Inputs: none

<a id="tool-en11f-get-decode"></a>
### `get_decode`

Read the decode function, the on-screen list, and one bus with the parameters of the protocol it is set to. Parameters of the other protocols are left unread. A protocol without typed parameters returns the bus state alone with a warning.

- Safety: Read-only
- Inputs:
  - `bus` (required): Decode bus 1 or 2. Accepted values `1`, `2`.

<a id="tool-en11f-configure-decode"></a>
### `configure_decode`

Enable decoding, set the on-screen list, and configure one bus with the protocol it is decoded as and that protocol parameters, then read back the requested values. Each parameter must be supported by the selected protocol. Thresholds adjusted by the scope are returned with a warning. Optional protocols return an availability warning.

- Safety: Setup change
- Inputs:
  - `bus` (required): Decode bus 1 or 2. Accepted values `1`, `2`.
  - `enabled` (optional): the decode function itself.
  - `list` (optional): Decode list on screen. Off hides it, D1 shows the list of bus 1 and D2 the list of bus 2. Accepted values `"OFF"`, `"D1"`, `"D2"`.
  - `list_lines` (optional): Lines the decode list shows on screen, 1 to 7. Minimum 1. Maximum 7.
  - `list_scroll` (optional): Line the decode list selects. The scope bounds it by the frames it decoded. Minimum 1. Maximum 1000000.
  - `bus_enabled` (optional): the decode bus itself.
  - `protocol` (optional): Protocol the bus is decoded as. The selection determines which parameters apply. 13 accepted values.
  - `format` (optional): Number format the decoded values are shown and answered in. Accepted values `"BINary"`, `"DECimal"`, `"HEX"`, `"ASCii"`.
  - `clock_source` (optional): Clock line. Use an analog channel C1-C4 or digital channel D0-D15. 20 accepted values.
  - `clock_threshold` (optional): threshold of the clock source in volts. Minimum -1000000. Maximum 1000000.
  - `data_source` (optional): Data line. Use an analog channel C1-C4 or digital channel D0-D15. 20 accepted values.
  - `data_threshold` (optional): threshold of the data source in volts. Minimum -1000000. Maximum 1000000.
  - `read_write` (optional): whether the decoded address carries its read and write bit.
  - `mosi_source` (optional): SPI MOSI line: an analog channel C1-C4 or a digital channel D0-D15, or DIS for no source. 21 accepted values.
  - `mosi_threshold` (optional): threshold of the SPI MOSI line in volts. Minimum -1000000. Maximum 1000000.
  - `miso_source` (optional): SPI MISO line: an analog channel C1-C4 or a digital channel D0-D15, or DIS for no source. 21 accepted values.
  - `miso_threshold` (optional): threshold of the SPI MISO line in volts. Minimum -1000000. Maximum 1000000.
  - `cs_source` (optional): SPI CS line: an analog channel C1-C4 or a digital channel D0-D15. 20 accepted values.
  - `cs_threshold` (optional): threshold of the SPI CS line in volts. Minimum -1000000. Maximum 1000000.
  - `ncs_source` (optional): SPI ~CS line: an analog channel C1-C4 or a digital channel D0-D15. 20 accepted values.
  - `ncs_threshold` (optional): threshold of the SPI ~CS line in volts. Minimum -1000000. Maximum 1000000.
  - `cs_type` (optional): SPI chip selection. CS uses chip select, NCS uses its inverse and Timeout uses a clock-idle duration.
  - `latch_edge` (optional): Rising or falling clock edge used to sample data. Accepted values `"RISing"`, `"FALLing"`.
  - `bit_order` (optional): Bit order. MSB reads the most significant bit first. LSB reads the least significant bit first. Accepted values `"LSB"`, `"MSB"`.
  - `data_length` (optional): Bits in one decoded word. The range depends on the selected protocol.
  - `rx_source` (optional): UART RX line: an analog channel C1-C4 or a digital channel D0-D15, or DIS for no source. 21 accepted values.
  - `rx_threshold` (optional): threshold of the UART RX line in volts. Minimum -1000000. Maximum 1000000.
  - `tx_source` (optional): UART TX line: an analog channel C1-C4 or a digital channel D0-D15, or DIS for no source. 21 accepted values.
  - `tx_threshold` (optional): threshold of the UART TX line in volts. Minimum -1000000. Maximum 1000000.
  - `baud` (optional): Baud rate preset or custom rate in bits per second. The accepted range depends on the selected protocol.
  - `parity` (optional): UART parity: NONE, ODD, EVEN, MARK or SPACe. Accepted values `"NONE"`, `"ODD"`, `"EVEN"`, `"MARK"`, `"SPACe"`.
  - `stop_bits` (optional): length of the UART stop bit: 1, 1.5 or 2 bit times. Accepted values `1`, `1.5`, `2`.
  - `idle_level` (optional): idle level of the line: LOW or HIGH. Accepted values `"LOW"`, `"HIGH"`.
  - `source` (optional): Bus source. Use an analog channel C1-C4 or digital channel D0-D15. 20 accepted values.
  - `threshold` (optional): threshold of the bus source in volts. Minimum -1000000. Maximum 1000000.
  - `data_baud` (optional): CAN FD data-phase baud rate preset or custom rate in bits per second.
  - `ws_source` (optional): IIS word select line: an analog channel C1-C4 or a digital channel D0-D15. 20 accepted values.
  - `ws_threshold` (optional): threshold of the IIS word select line in volts. Minimum -1000000. Maximum 1000000.
  - `audio_variant` (optional): IIS audio variant. LJ is left justified and RJ is right justified. Accepted values `"I2S"`, `"LJ"`, `"RJ"`.
  - `left_level` (optional): level of the IIS word select line that marks the left channel: LOW or HIGH. Accepted values `"LOW"`, `"HIGH"`.
  - `annotate` (optional): IIS channel annotated on screen: ALL, LEFT or RIGHt. Accepted values `"ALL"`, `"LEFT"`, `"RIGHt"`.
  - `start_bit` (optional): first bit of the IIS data word, 0 to 31. Minimum 0. Maximum 31.
  - `upper_threshold` (optional): upper threshold of the M1553 source in volts, which the scope keeps at or above lower_threshold. Minimum -1000000. Maximum 1000000.
  - `lower_threshold` (optional): lower threshold of the M1553 source in volts, which the scope keeps at or below upper_threshold. Minimum -1000000. Maximum 1000000.
  - `message_format` (optional): SENT message format: NIBBles, FSIGnal fast signal, SSERial short serial or ESERial enhanced serial. Accepted values `"NIBBles"`, `"FSIGnal"`, `"SSERial"`, `"ESERial"`.
  - `crc_2010` (optional): the 2010 SENT CRC format. Off selects the 2008 format.
  - `pause_pulse` (optional): the SENT pause pulse.
  - `clock_period` (optional): SENT clock tick in seconds, 500 ns to 300 us. Minimum 5e-7. Maximum 0.0003.
  - `tolerance` (optional): SENT clock tolerance in percent, 1 to 25. Minimum 1. Maximum 25.
  - `nibbles` (optional): nibbles of one SENT message, 3 to 8. Minimum 3. Maximum 8.
  - `polarity` (optional): Manchester edge that encodes a logic 1: RISing or FALLing. Accepted values `"RISing"`, `"FALLing"`.
  - `display_format` (optional): Manchester display format: WORD or BIT. Accepted values `"WORD"`, `"BIT"`.
  - `idle_bits` (optional): idle bits of the Manchester bus, 2 to 32. Minimum 2. Maximum 32.
  - `start_edge` (optional): start edge of the Manchester bus, 1 to 32. Minimum 1. Maximum 32.
  - `sync_size` (optional): sync size of the Manchester bus, 0 to 32. Minimum 0. Maximum 32.
  - `header_size` (optional): header size of the Manchester bus, 0 to 32. Minimum 0. Maximum 32.
  - `trailer_size` (optional): trailer size of the Manchester bus, 0 to 32. Minimum 0. Maximum 32.
  - `word_size` (optional): word size of the Manchester bus, 2 to 8. Minimum 2. Maximum 8.
  - `data_size` (optional): data word length of the Manchester bus, 1 to 255. Minimum 1. Maximum 255.

<a id="tool-en11f-copy-decode-settings"></a>
### `copy_decode_settings`

Copy the serial settings between one decode bus and the trigger. From Trigger overwrites the bus settings with the trigger ones, To Trigger overwrites the trigger settings with the bus ones. The overwritten settings are not saved anywhere and the command has no query form.

- Safety: Destructive
- Inputs:
  - `bus` (required): Decode bus 1 or 2. Accepted values `1`, `2`.
  - `direction` (required): From Trigger copies the trigger setup into the bus. To Trigger copies the bus setup into the trigger. Accepted values `"FROMtrigger"`, `"TOTRigger"`.

<a id="tool-en11f-read-decode-result"></a>
### `read_decode_result`

Read up to 500 decoded frames from one bus in its selected number format. Returns the protocol, format, column names, total frame count, and the requested slice. The decode function and bus must both be on. Enable them with configure_decode first.

- Safety: Read-only
- Inputs:
  - `bus` (required): Decode bus 1 or 2. Accepted values `1`, `2`.
  - `first_frame` (required): Index of the first frame to return. Default `0`. Minimum 0. Maximum 1000000.
  - `max_frames` (required): Frames to return at most, counted from first_frame. Default `50`. Minimum 1. Maximum 500.

<a id="tool-en11f-get-display"></a>
### `get_display`

Read the display configuration, including axis labels, backlight, color grading, grid style and intensity, trace intensity, menu style, persistence and interpolation. Transparence is included on SHS800X/SHS1000X handhelds only.

- Safety: Read-only
- Inputs: none

<a id="tool-en11f-configure-display"></a>
### `configure_display`

Set the display configuration and read back the requested values. Sub-second persistence is available on the larger series only and transparence on SHS800X/SHS1000X handhelds only. Values the scope did not take are returned with a warning.

- Safety: Setup change
- Inputs:
  - `axis_labels` (optional): the axis labels on the grid.
  - `axis_mode` (optional): Fixed keeps the axes in place while their coordinates follow the waveform. Moving lets the axes move with it. Accepted values `"FIXed"`, `"MOVing"`.
  - `backlight` (optional): screen backlight in percent, 0 to 100. Minimum 0. Maximum 100.
  - `color_grade` (optional): color grading, which colors the trace by how often a point is hit.
  - `grid_intensity` (optional): grid brightness in percent, 0 to 100. Minimum 0. Maximum 100.
  - `grid` (optional): grid style. Accepted values `"FULL"`, `"LIGHt"`, `"NONE"`.
  - `trace_intensity` (optional): waveform brightness in percent, 0 to 100. Minimum 0. Maximum 100.
  - `menu_style` (optional): menu style, embedded beside the grid or floating over it. Accepted values `"EMBedded"`, `"FLOating"`.
  - `menu_hide` (optional): time after which the menu hides itself. Accepted values `"OFF"`, `"3S"`, `"5S"`, `"10S"`, `"30S"`, `"60S"`.
  - `persistence` (optional): Persistence duration. The sub-second values are available on the larger series only. Accepted values `"OFF"`, `"INFinite"`, `"100MS"`, `"200MS"`, `"500MS"`, `"1S"`, `"5S"`, `"10S"`, `"30S"`.
  - `transparence` (optional): Transparency of the information bar in percent, 0 to 100. SHS800X/SHS1000X handhelds only. Minimum 0. Maximum 100.
  - `join_points` (optional): Draw interpolation lines between sample points. Disable to show dots.

<a id="tool-en11f-clear-display"></a>
### `clear_display`

Clear the waveform displayed on the screen. Accumulated persistence and color grading are discarded and cannot be restored. The command has no query form.

- Safety: Destructive
- Inputs: none

<a id="tool-en11f-get-history"></a>
### `get_history`

Read history mode, the current frame, the playback interval, the history list, the playback state and the acquire timestamp of the current frame. When history mode is off, only the mode is read, because frames exist only while it is on.

- Safety: Read-only
- Inputs: none

<a id="tool-en11f-configure-history"></a>
### `configure_history`

Turn history mode on or off, select a frame, set the playback interval, show or hide the history list and control playback, then read back the requested values. Selecting a frame, showing the list or playing requires history mode. The scope clamps a frame it does not hold, which is returned with a warning.

- Safety: Setup change
- Inputs:
  - `enabled` (optional): History mode on or off. A frame, the list and playback require it to be on.
  - `frame` (optional): Frame to show, 1 to the newest frame the scope holds. Memory depth bounds how many frames exist. Minimum 1. Maximum 9007199254740991.
  - `interval` (optional): seconds a frame stays on screen during playback, 1 us to 1 s. Minimum 0.000001. Maximum 1.
  - `list` (optional): the history list beside the waveform.
  - `list_type` (optional): Time column of the list: the sampling time or the interval between frames. Requires list. Accepted values `"TIME"`, `"DELTa"`.
  - `play` (optional): Playback of the recorded frames. Forwards plays first-to-last, backwards last-to-first. Accepted values `"BACKWards"`, `"PAUSe"`, `"FORWards"`.

<a id="tool-en11f-get-counter"></a>
### `get_counter`

Read the hardware counter mode, source, level and settings relevant to the active mode. Frequency and Period include statistics settings. Totalizer includes its gate and counted-edge settings. The counted value is not available through this tool.

- Safety: Read-only
- Inputs: none

<a id="tool-en11f-configure-counter"></a>
### `configure_counter`

Set the hardware counter and read back the requested settings. Statistics settings apply to Frequency and Period modes. Gate settings apply to Totalizer mode. Levels adjusted by the scope are returned with a warning. Counter availability cannot be determined from the model identity.

- Safety: Setup change
- Inputs:
  - `counter` (optional): the counter function itself.
  - `mode` (optional): What the counter counts. Frequency averages over a set period. Period is its reciprocal. Totalizer is the cumulative count. Accepted values `"FREQuency"`, `"PERiod"`, `"TOTalizer"`.
  - `source` (optional): the analog channel the counter counts. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`.
  - `level` (optional): the level in volts an edge is counted at. Minimum -1000000. Maximum 1000000.
  - `statistics` (optional): Counter statistics. Available in Frequency and Period modes.
  - `gate` (optional): the gate that decides when the totalizer counts.
  - `gate_level` (optional): the level in volts the gate opens at. Minimum -1000000. Maximum 1000000.
  - `gate_slope` (optional): The edge that opens an Edge gate, or the polarity counted by a Level gate. Accepted values `"RISing"`, `"FALLing"`.
  - `gate_type` (optional): Level counts while the gate source holds the polarity named by gate_slope. Edge counts from one gate edge to the next. Accepted values `"LEVel"`, `"AEDGe"`.
  - `totalizer_slope` (optional): the edge of the counter source the totalizer counts. Accepted values `"RISing"`, `"FALLing"`.

<a id="tool-en11f-reset-counter"></a>
### `reset_counter`

Reset the counter. Frequency and Period modes discard accumulated statistics. Totalizer mode discards the cumulative count. The reset cannot be undone and has no query form. An unknown mode sends nothing and returns a warning.

- Safety: Destructive
- Inputs: none

<a id="tool-en11f-get-mask-test"></a>
### `get_mask_test`

Read the mask test function, the source it watches, what it takes as a passing frame, and what it does with a failing one. Use read_mask_test_result for the pass and fail counts.

- Safety: Read-only
- Inputs: none

<a id="tool-en11f-configure-mask-test"></a>
### `configure_mask_test`

Set the mask test up and start or stop it, then read back the requested values. The test compares each acquired frame with the mask the scope currently holds, which create_mask and load_mask replace. Stop on Fail stops acquisition at the first failing frame and Capture on Fail writes an image file per failure, so both change more than the display.

- Safety: Setup change
- Inputs:
  - `mask_test` (optional): Whether the mask test function is on.
  - `source` (optional): Waveform the mask test watches: an analog channel C1-C4 or its zoomed trace Z1-Z4. Only a zoomed source can be selected while zoom is on. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`, `"Z1"`, `"Z2"`, `"Z3"`, `"Z4"`.
  - `type` (optional): What the test takes as a passing frame. ALL_IN takes a waveform wholly inside the mask, ALL_OUT one wholly outside it, ANY_IN one partly inside and ANY_OUT one partly outside. Accepted values `"ALL_IN"`, `"ALL_OUT"`, `"ANY_IN"`, `"ANY_OUT"`.
  - `display_results` (optional): Whether the pass and fail counts are shown on the scope screen.
  - `buzzer_on_fail` (optional): Whether the scope beeps when a frame fails.
  - `capture_on_fail` (optional): Whether a failing frame is saved as an image under SIGLENT/ on the scope storage. Every failure writes another file and nothing here can tell how much room is left.
  - `failure_to_history` (optional): Whether failing frames are kept in the history buffer.
  - `stop_on_fail` (optional): Whether acquisition stops as soon as a frame fails.
  - `running` (optional): Whether the mask test is running. Turning it on starts testing and off stops it. Whether starting a test discards the counts of the previous run is not documented.

<a id="tool-en11f-read-mask-test-result"></a>
### `read_mask_test_result`

Read how many frames the mask test has failed, passed and tested. The mask test function is read first and the counts are not asked for while it is off. Counts read while the test is not running are those of the last run.

- Safety: Read-only
- Inputs: none

<a id="tool-en11f-reset-mask-test"></a>
### `reset_mask_test`

Discard the accumulated pass, fail and total counts of the mask test and start counting again. The counts are not stored anywhere else and cannot be restored. The command has no query form.

- Safety: Destructive
- Inputs: none

<a id="tool-en11f-create-mask"></a>
### `create_mask`

Build a mask around the waveform on screen from a horizontal and a vertical margin. The current mask is replaced, and the scope does not report either margin, so the previous mask cannot be read back or restored. Requires confirm_replace_mask: true. Nothing is sent otherwise.

- Safety: Destructive
- Inputs:
  - `x_margin` (required): Horizontal margin of the mask, 0.08 to 4.00. The unit is not reported. Minimum 0.08. Maximum 4.
  - `y_margin` (required): Vertical margin of the mask, 0.08 to 4.00. The unit is not reported. Minimum 0.08. Maximum 4.
  - `confirm_replace_mask` (required): Explicit acknowledgement that the mask the scope currently holds is replaced. Required value `true`.

<a id="tool-en11f-load-mask"></a>
### `load_mask`

Recall a mask from internal slot 1-4 or from a .msk or .smsk file on scope storage. The current mask is replaced. The scope provides no mask listing or load status, so the selected slot or file cannot be checked first and the result cannot be confirmed. Requires confirm_replace_mask: true. Nothing is sent otherwise.

- Safety: Destructive
- Inputs:
  - `slot` (optional): Internal mask slot 1 to 4. Accepted values `1`, `2`, `3`, `4`.
  - `file` (optional): Mask file on scope storage, for example local/SIGLENT/TEST.msk. Maximum length 200.
  - `confirm_replace_mask` (required): Explicit acknowledgement that the mask the scope currently holds is replaced. Required value `true`.

<a id="tool-en11f-get-dvm-reading"></a>
### `get_dvm_reading`

Read the digital voltmeter settings and displayed value. When the voltmeter is off, no value is read and a warning is returned. Hold returns the frozen value with a warning. A nonnumeric result is preserved as raw text. Digital voltmeter availability cannot be determined from the model identity.

- Safety: Read-only
- Inputs: none

<a id="tool-en11f-configure-dvm"></a>
### `configure_dvm`

Set the digital voltmeter and read back the requested settings. The source must be an available analog channel C1-C4. Values rejected by the scope are returned with a warning. Digital voltmeter availability cannot be determined from the model identity.

- Safety: Setup change
- Inputs:
  - `dvm` (optional): the digital voltmeter itself.
  - `source` (optional): the analog channel the DVM measures. Accepted values `"C1"`, `"C2"`, `"C3"`, `"C4"`.
  - `mode` (optional): What the digital voltmeter displays. Choose DC average, DC RMS, AC RMS, peak-to-peak, or amplitude. Accepted values `"DCavg"`, `"DCRMs"`, `"ACRMs"`, `"PKPK"`, `"AMPLitude"`.
  - `auto_range` (optional): following the signal with the vertical range automatically.
  - `alarm` (optional): the overload alarm, which sounds when the amplitude leaves the screen.
  - `hold` (optional): freezing the displayed value, which then stops following the signal.

<a id="tool-en11f-get-waveform-generator"></a>
### `get_waveform_generator`

Read the built-in waveform generator: the wave it is set to, the output state and load, the arbitrary waveform selected, the synchronization output, over-voltage protection and the stored waveform list. Generator availability cannot be determined from the model identity.

- Safety: Read-only
- Inputs:
  - `store` (optional): Restrict the stored waveform list to the built-in or the user waveforms. Both are listed by default. Accepted values `"BUILDIN"`, `"USER"`.

<a id="tool-en11f-configure-waveform-generator"></a>
### `configure_waveform_generator`

Set the built-in waveform generator and switch its output on or off. Enabling the output, or changing anything while it is already on, drives the connected circuit and requires confirm_output_enable: true. Switching the output off requires no acknowledgement and is sent first. Turning voltage_protection off removes the over-voltage protection of the output, which is the consequential direction of that setting. Generator availability cannot be determined from the model identity.

- Safety: Destructive
- Inputs:
  - `type` (optional): Basic waveform type. Left out, the generator keeps the type it holds. Accepted values `"SINE"`, `"SQUARE"`, `"RAMP"`, `"PULSE"`, `"NOISE"`, `"ARB"`, `"DC"`, `"PRBS"`, `"IQ"`.
  - `frequency` (optional): Frequency in Hz. Maximum 1000000000.
  - `period` (optional): Period in seconds, the reciprocal of the frequency. Maximum 1000.
  - `amplitude` (optional): Peak-to-peak amplitude in volts. Minimum -1000. Maximum 1000.
  - `offset` (optional): Offset in volts. Minimum -1000. Maximum 1000.
  - `symmetry` (optional): Symmetry of a ramp in percent, 0 to 100. Minimum 0. Maximum 100.
  - `duty` (optional): Duty cycle in percent, 0 to 100. It depends on the frequency. Minimum 0. Maximum 100.
  - `deviation` (optional): Standard deviation of noise in volts. Minimum -1000. Maximum 1000.
  - `mean` (optional): Mean of noise in volts. Minimum -1000. Maximum 1000.
  - `width` (optional): Positive pulse width in seconds. Maximum 1000.
  - `output` (optional): Whether the front-panel generator output drives the circuit connected to it.
  - `load` (optional): Output load in ohms. HZ is high impedance. Accepted values `"50"`, `"HZ"`.
  - `sync` (optional): Whether the synchronization output is on.
  - `voltage_protection` (optional): Whether over-voltage protection is on.
  - `arbitrary_index` (optional): Arbitrary waveform to select by index. get_waveform_generator lists the indexes this model holds. Minimum 0. Maximum 999.
  - `arbitrary_name` (optional): Arbitrary waveform to select by name. get_waveform_generator lists the names this model holds.
  - `confirm_output_enable` (optional): Explicit acknowledgement that the generator output drives the circuit connected to it. Required value `true`.

<a id="tool-en11f-read-meter"></a>
### `read_meter`

Read the function the handheld multimeter is set to and the value it measures. Enter the meter with configure_meter first because its active state cannot be checked remotely. An out-of-range reading is returned as Overload. SHS800X and SHS1000X handhelds only.

- Safety: Read-only
- Inputs: none

<a id="tool-en11f-configure-meter"></a>
### `configure_meter`

Enter or leave the handheld multimeter and set the function it measures, its range, its mA or V unit and its relative reading. Choosing a function resets every measurement parameter to its default, then the requested unit and relative setting are applied again. The selected function is verified, but the meter state, range, unit, and relative setting cannot be read back. SHS800X and SHS1000X handhelds only.

- Safety: Setup change
- Inputs:
  - `meter` (optional): Enter the multimeter, or leave it and return to the oscilloscope.
  - `function` (optional): Measurement function. Selecting one returns every measurement parameter to its default. Accepted values `"continuity"`, `"current_ac"`, `"current_dc"`, `"diode"`, `"resistance"`, `"voltage_ac"`, `"voltage_dc"`, `"capacitance"`.
  - `range` (optional): Measurement range. AUTO ranges per measurement, MIN, MAX and DEF take the documented limits. 21 accepted values.
  - `relative` (optional): Whether readings are shown relative to a stored value. The instrument clears this on every function change.
  - `unit` (optional): Unit the current or voltage function displays in. Accepted values `"MA"`, `"A"`, `"MV"`, `"V"`.

<a id="tool-en11f-measure-meter"></a>
### `measure_meter`

Set the handheld multimeter to a function with its default parameters and read one measurement in the same call. This resets every measurement parameter of that function, so use configure_meter and read_meter when a parameter has to survive. A reading out of range answers Overload and is reported as such. SHS800X and SHS1000X handhelds only.

- Safety: Setup change
- Inputs:
  - `function` (required): Measurement function to switch to and read. Accepted values `"continuity"`, `"current_ac"`, `"current_dc"`, `"diode"`, `"resistance"`, `"voltage_ac"`, `"voltage_dc"`, `"capacitance"`.
  - `range` (optional): Measurement range. Left out, the documented default of autoranging applies. 18 accepted values.

<a id="tool-en11f-get-memory"></a>
### `get_memory`

Read one memory waveform M1-M4: display switch, horizontal position, scale and sync, label, label text, vertical position and scale. On SDS1204X HD firmware 6.9.13.1.1.6.7 no memory query answers while the memory holds no waveform, including the display switch, so this tool refuses unless loaded: true asserts that a waveform was imported into this memory. The import command has no query form and the memory contents cannot be read back.

- Safety: Read-only
- Inputs:
  - `memory` (required): Memory waveform, 1 for M1 to 4 for M4. Model-specific limits are unknown, so four is the validation cap. Default `1`. Minimum 1. Maximum 4.
  - `loaded` (required): Assertion that this memory holds an imported waveform. No memory query answers otherwise. Required value `true`.

<a id="tool-en11f-configure-memory"></a>
### `configure_memory`

Set the display, position, scale, sync and label of one memory waveform M1-M4. On SDS1204X HD firmware 6.9.13.1.1.6.7 no memory query answers while the memory holds no waveform, so settings are read back only when loaded: true asserts that a waveform was imported into this memory, and are otherwise write only with a warning. Use import_memory to load a waveform into the memory. Values adjusted by the scope are returned with a warning.

- Safety: Setup change
- Inputs:
  - `memory` (required): Memory waveform, 1 for M1 to 4 for M4. Model-specific limits are unknown, so four is the validation cap. Default `1`. Minimum 1. Maximum 4.
  - `loaded` (optional): Assertion that this memory holds an imported waveform, enabling read-back. Required value `true`.
  - `horizontal_position` (optional): horizontal position of the memory waveform in seconds, like a trigger delay. Minimum -10000. Maximum 10000.
  - `horizontal_scale` (optional): horizontal scale of the memory waveform in seconds per division. Minimum 1e-12. Maximum 10000.
  - `horizontal_sync` (optional): following the horizontal parameters of the imported source.
  - `label` (optional): the label on screen.
  - `label_text` (optional): label text, up to 20 characters. Maximum length 20.
  - `enabled` (optional): the display of the memory waveform.
  - `vertical_position` (optional): vertical position of the memory waveform in its own unit. Minimum -1000000000000. Maximum 1000000000000.
  - `vertical_scale` (optional): vertical scale per division of the memory waveform in its own unit. Minimum 1e-12. Maximum 1000000000000.

<a id="tool-en11f-import-memory"></a>
### `import_memory`

Import a waveform into one memory M1-M4 from an analog channel C1-C4, a zoomed trace Z1-Z4, a math function F1-F4, another memory or a .bin waveform file on scope storage, then wait for completion. The import replaces the memory contents, which cannot be read back or restored. The scope provides no file listing, so a named file cannot be checked first. Requires confirm_overwrite_memory: true. Nothing is sent otherwise.

- Safety: Destructive
- Inputs:
  - `memory` (required): Memory waveform, 1 for M1 to 4 for M4. Model-specific limits are unknown, so four is the validation cap. Default `1`. Minimum 1. Maximum 4.
  - `source` (optional): waveform to import: C1-C4, Z1-Z4, F1-F4 or M1-M4. 16 accepted values.
  - `file` (optional): waveform file on scope storage, for example local/SIGLENT/test.bin. Maximum length 200.
  - `confirm_overwrite_memory` (required): Explicit acknowledgement that the memory waveform is replaced. Required value `true`.
  - `timeout_ms` (optional): Completion timeout in milliseconds, default 30000. Minimum 100. Maximum 120000.

<a id="tool-en11f-get-reference"></a>
### `get_reference`

Read one reference waveform REFA-REFD: label, label text, source, vertical scale and vertical position. The display state has no query form and cannot be read.

- Safety: Read-only
- Inputs:
  - `location` (required): Reference waveform REFA to REFD. Accepted values `"REFA"`, `"REFB"`, `"REFC"`, `"REFD"`. Default `"REFA"`.

<a id="tool-en11f-configure-reference"></a>
### `configure_reference`

Configure one reference waveform REFA-REFD: save a waveform into it, recall a .ref file from scope storage into it, call it up or take it off screen, and set its label and vertical scale and position. Saving or recalling replaces the stored reference, which cannot be restored, and requires confirm_overwrite_reference: true. Scale and position are accepted only while the reference is saved and displayed, and that state cannot be checked first.

- Safety: Destructive
- Inputs:
  - `location` (required): Reference waveform REFA to REFD. Accepted values `"REFA"`, `"REFB"`, `"REFC"`, `"REFD"`. Default `"REFA"`.
  - `save_source` (optional): Save this waveform into the reference: an analog channel C1-C4, a math function F1-F4 or a digital line D0-D15. Requires confirm_overwrite_reference. 24 accepted values.
  - `recall_file` (optional): Recall this .ref file from scope storage into the reference. Requires confirm_overwrite_reference. Maximum length 200.
  - `display` (optional): true calls the reference up on screen, false takes it off.
  - `label` (optional): the label on screen.
  - `label_text` (optional): label text, up to 20 characters. Maximum length 20.
  - `vertical_scale` (optional): Vertical scale per division of the reference in its own unit. Available only while the reference is saved and displayed. Minimum 1e-12. Maximum 1000000000000.
  - `vertical_position` (optional): Vertical offset of the reference in its own unit. Available only while the reference is saved and displayed. Minimum -1000000000000. Maximum 1000000000000.
  - `confirm_overwrite_reference` (optional): Explicit acknowledgement that the waveform stored in the reference is replaced. Required value `true`.

<a id="tool-en11f-save-panel-setup"></a>
### `save_panel_setup`

Save the current setup to internal slot 1-10, to an .xml file on scope storage, or as the default setup the Default key restores, then wait for completion. An existing setup in that slot or file cannot be detected and is replaced. Requires confirm_overwrite: true. Nothing is sent otherwise.

- Safety: Destructive
- Inputs:
  - `slot` (optional): Internal setup slot 1 to 10, stored as SDS000x.xml. Minimum 1. Maximum 10.
  - `file` (optional): Setup file on scope storage, for example local/SIGLENT/default.xml. Maximum length 200.
  - `default_setup` (optional): Save the current settings (CUSTom) or the factory settings (FACTory) as the default setup. Accepted values `"CUSTom"`, `"FACTory"`.
  - `confirm_overwrite` (required): Explicit acknowledgement that an existing setup in that slot or file is replaced. Required value `true`.
  - `timeout_ms` (optional): Completion timeout in milliseconds, default 30000. Minimum 100. Maximum 120000.

<a id="tool-en11f-recall-panel-setup"></a>
### `recall_panel_setup`

Recall a setup from internal slot 1-10, from an .xml file on scope storage, or the factory settings, then wait for completion. Recalling replaces every scope setting. The scope provides no setup listing, so a named slot or file cannot be checked first. Requires confirm_recall: true. Nothing is sent otherwise.

- Safety: Destructive
- Inputs:
  - `slot` (optional): Internal setup slot 1 to 10. Minimum 1. Maximum 10.
  - `file` (optional): Setup file on scope storage, for example local/SIGLENT/default.xml. Maximum length 200.
  - `factory` (optional): Recall the factory settings. Required value `true`.
  - `confirm_recall` (required): Explicit acknowledgement that the current scope settings are discarded. Required value `true`.
  - `timeout_ms` (optional): Completion timeout in milliseconds, default 30000. Minimum 100. Maximum 120000.

<a id="tool-en11f-erase-internal-storage"></a>
### `erase_internal_storage`

Delete every user defined file stored inside the scope: reference waveforms, internal setups, internal mask files, custom default setups and waveform files copied to the AWG, then wait for completion. Files on USB or network storage are kept. This cannot be undone. Requires confirm_erase: true. Nothing is sent otherwise.

- Safety: Destructive
- Inputs:
  - `confirm_erase` (required): Explicit acknowledgement that every user defined file inside the scope is deleted. Required value `true`.
  - `timeout_ms` (optional): Completion timeout in milliseconds, default 30000. Minimum 100. Maximum 120000.

<a id="tool-en11f-save-waveform-file"></a>
### `save_waveform_file`

Save waveform data to a file on scope storage and wait for completion. BINary writes .bin, CSV writes .csv with optional instrument parameters, MATLab writes .mat and REFerence writes a .ref reference waveform. The path extension must match the format. An existing file cannot be detected and is replaced. Requires confirm_overwrite: true. Nothing is sent otherwise.

- Safety: Destructive
- Inputs:
  - `format` (required): file format written. Accepted values `"BINary"`, `"CSV"`, `"MATLab"`, `"REFerence"`.
  - `path` (required): destination on scope storage, for example U-disk0/SIGLENT/c1.bin. Maximum length 200.
  - `source` (required): Waveform to save. BINary takes C1-C4, Z1-Z4, F1-F4, M1-M4 and the per-bit digital groups D0_D15 and ZD0_ZD15. CSV and MATLab add the by-bus groups DIGital and ZDIGital. REFerence takes C1-C4, F1-F4 or a digital line D0-D15. 36 accepted values.
  - `include_parameters` (optional): Also write the instrument configuration into the file. CSV format only, default off.
  - `confirm_overwrite` (required): Explicit acknowledgement that an existing file is replaced. Required value `true`.
  - `timeout_ms` (optional): Completion timeout in milliseconds, default 30000. Minimum 100. Maximum 120000.

<a id="tool-en11f-save-screenshot"></a>
### `save_screenshot`

Save a screenshot to a .bmp, .jpg or .png file on scope storage and wait for completion. The image format follows the file extension. An existing file cannot be detected and is replaced. Requires confirm_overwrite: true. Nothing is sent otherwise. Use capture_screenshot to transfer the image to the client instead.

- Safety: Destructive
- Inputs:
  - `path` (required): destination on scope storage, for example U-disk0/SIGLENT/screen.png. Maximum length 200.
  - `inverted` (required): Store the image with inverted colors, a white background instead of a black one. Default `false`.
  - `confirm_overwrite` (required): Explicit acknowledgement that an existing file is replaced. Required value `true`.
  - `timeout_ms` (optional): Completion timeout in milliseconds, default 30000. Minimum 100. Maximum 120000.

<a id="tool-en11f-get-system-settings"></a>
### `get_system_settings`

Read the buzzer, clock, language, power-on, remote lock, screensaver, touch screen, education-mode and self-calibration settings. Education fields report whether each function is usable. The menu setting is unavailable because some models do not support reading it.

- Safety: Read-only
- Inputs: none

<a id="tool-en11f-configure-system-settings"></a>
### `configure_system_settings`

Set system settings and read back the requested values. Set an education field to false to lock Auto Setup, measurements or cursors. Engaging the remote lock requires the server to run with the enable-lock flag and is refused before anything is sent otherwise. Releasing it is always accepted. The menu setting has no supported read-back and is reported under write_only.

- Safety: Setup change
- Inputs:
  - `buzzer` (optional): sound the buzzer.
  - `clock_source` (optional): clock source: EXT is external and disables the 10 MHz output, IN_ON and IN_OFF are internal with that output on or off. Accepted values `"EXT"`, `"IN_ON"`, `"IN_OFF"`.
  - `date` (optional): system date as YYYY-MM-DD.
  - `language` (optional): display language. Accepted values `"SCHinese"`, `"TCHinese"`, `"ENGLish"`, `"FRENch"`, `"JAPanese"`, `"KORean"`, `"DEUTsch"`, `"ESPan"`, `"RUSSian"`, `"ITALiana"`, `"PORTuguese"`.
  - `power_on_line` (optional): reboot on its own once power comes back.
  - `remote_lock` (optional): remote control, which locks the touch screen, front panel and peripherals.
  - `screensaver` (optional): idle time after which the monitor is blanked. Accepted values `"OFF"`, `"1MIN"`, `"5MIN"`, `"10MIN"`, `"30MIN"`, `"60MIN"`.
  - `time` (optional): system time as HH:MM:SS.
  - `touch_screen` (optional): touch screen.
  - `menu` (optional): Menu bar on screen. Available on models with a menu switch and never read back.
  - `autosetup_enabled` (optional): Leave Auto Setup usable. False locks it.
  - `measure_enabled` (optional): Leave measurements usable. False locks them.
  - `cursors_enabled` (optional): Leave cursors usable. False locks them.

<a id="tool-en11f-get-lan-configuration"></a>
### `get_lan_configuration`

Read the gateway, IPv4 address, subnet mask, address mode, MAC address and VNC port.

- Safety: Read-only
- Inputs: none

<a id="tool-en11f-configure-lan"></a>
### `configure_lan`

Change the scope's address mode, IPv4 address, subnet mask, gateway and VNC port. Changing the address or enabling DHCP may end the current connection. Requires confirm_network: true. Nothing is sent otherwise.

- Safety: Destructive
- Inputs:
  - `gateway` (optional): default gateway.
  - `address` (optional): IPv4 address of the scope.
  - `netmask` (optional): subnet mask.
  - `lan_type` (optional): STATIC keeps the addresses configured here, DHCP takes them from the network. Accepted values `"STATIC"`, `"DHCP"`.
  - `vnc_port` (optional): VNC port, 5900 to 5999. Minimum 5900. Maximum 5999.
  - `confirm_network` (required): Explicit acknowledgement that the network settings change and this connection may die. Required value `true`.

<a id="tool-en11f-get-network-storage"></a>
### `get_network_storage`

Read the configured network drive and whether it is mounted. The password is returned as ***.

- Safety: Read-only
- Inputs: none

<a id="tool-en11f-configure-network-storage"></a>
### `configure_network_storage`

Set the network drive and optionally mount or unmount it, then read the configuration back. Omitted fields are cleared, which is why this call is destructive. The password travels to the scope in clear text and appears in the echoed command. The read-back masks it as ***. Provide path, connect, or both.

- Safety: Destructive
- Inputs:
  - `path` (optional): server path to mount, e.g. //10.12.255.239/nfs. Minimum length 1. Maximum length 128.
  - `user` (optional): user name, empty for none. Maximum length 64.
  - `password` (optional): Password. It travels in clear text and is returned as ***. Maximum length 64.
  - `anonymous` (optional): mount anonymously.
  - `auto_connect` (optional): mount again on its own.
  - `remember_path` (optional): keep the path for the next mount.
  - `remember_user` (optional): keep the user name for the next mount.
  - `remember_password` (optional): keep the password for the next mount.
  - `connect` (optional): true mounts the drive, false unmounts it.

<a id="tool-en11f-calibrate-scope"></a>
### `calibrate_scope`

Run self-calibration and wait for completion. Disconnect everything from the inputs first. The scope is unavailable during calibration and may continue calibrating after a timeout closes the connection. Requires confirm_inputs_disconnected: true. Nothing is sent otherwise.

- Safety: Destructive
- Inputs:
  - `confirm_inputs_disconnected` (required): Explicit acknowledgement that every input is disconnected and the scope may go out of service. Required value `true`.
  - `timeout_ms` (optional): Calibration timeout in milliseconds, default 300000. Each wait for an answer is also bounded by the server response ceiling, 180000 by default, so a calibration that runs longer needs --max-response-timeout raised. Minimum 10000. Maximum 900000.

<a id="tool-en11f-reboot-scope"></a>
### `reboot_scope`

Restart the scope. The connection drops during restart and unsaved settings are lost. Requires confirm_reboot: true. Nothing is sent otherwise.

- Safety: Destructive
- Inputs:
  - `confirm_reboot` (required): Explicit acknowledgement that the scope restarts and this connection drops. Required value `true`.

<a id="tool-en11f-shutdown-scope"></a>
### `shutdown_scope`

Shut the scope down. It stops answering until switched on at the instrument, unless power_on_line is enabled and power is cycled. Requires confirm_shutdown: true. Nothing is sent otherwise.

- Safety: Destructive
- Inputs:
  - `confirm_shutdown` (required): Explicit acknowledgement that the scope powers off and answers nothing until it is switched on. Required value `true`.

## Power supply

<a id="tool-power-supply-identify"></a>
### `identify`

Identify the connected power supply. Returns its manufacturer, model, serial number, firmware, family, command set, and channel count.

- Safety: Read-only
- Inputs: none

<a id="tool-power-supply-get-power-status"></a>
### `get_power_status`

Read the working state, software version, and selected channel. The working state is hexadecimal and kept in raw. Models outside the recognized SPD families receive only the raw value.

- Safety: Read-only
- Inputs: none

<a id="tool-power-supply-save-state"></a>
### `save_state`

Save the current instrument state to location 1-5. An existing state may be overwritten because occupied locations cannot be checked. Requires confirm_overwrite: true. Nothing is sent otherwise.

- Safety: Destructive
- Inputs:
  - `slot` (required): Saved-state location 1-5. Minimum 1. Maximum 5.
  - `confirm_overwrite` (required): Acknowledge that this location may hold a state that will be lost. Required value `true`.

<a id="tool-power-supply-recall-state"></a>
### `recall_state`

Recall saved state 1-5, replacing the current settings, including output values. Requires confirm_recall: true. Nothing is sent otherwise.

- Safety: Destructive
- Inputs:
  - `slot` (required): Saved-state location 1-5. Minimum 1. Maximum 5.
  - `confirm_recall` (required): Acknowledge that the current settings will be replaced. Required value `true`.

<a id="tool-power-supply-delete-state"></a>
### `delete_state`

Delete saved state 1-5. Available on SPD1000X only. Requires confirm_delete: true. Nothing is sent otherwise.

- Safety: Destructive
- Inputs:
  - `slot` (required): Saved-state location 1-5. Minimum 1. Maximum 5.
  - `confirm_delete` (required): Acknowledge that the saved state will be lost. Required value `true`.

<a id="tool-power-supply-lock-front-panel"></a>
### `lock_front_panel`

Lock or unlock the front-panel keys. The lock state cannot be read back because these commands have no query form.

- Safety: Setup change
- Inputs:
  - `locked` (required): Set to true to lock the keys or false to unlock them.

<a id="tool-power-supply-scpi-query"></a>
### `scpi_query`

Send a raw SCPI query and return its text response. Use for operations without a typed tool. An unsupported or non-responsive query can block until the timeout closes the connection.

- Safety: Destructive
- Inputs:
  - `command` (required): SCPI query, for example 'SYSTem:ERRor?'. Minimum length 1. Maximum length 256.
  - `timeout_ms` (optional): Response timeout in milliseconds. Minimum 100. Maximum 120000.

<a id="tool-power-supply-scpi-command"></a>
### `scpi_command`

Send a raw SCPI command without reading a response. Use for operations without a typed tool.

- Safety: Destructive
- Inputs:
  - `command` (required): SCPI command, for example 'OUTPut CH1,OFF'. Minimum length 1. Maximum length 256.

<a id="tool-power-supply-measure-output"></a>
### `measure_output`

Measure the voltage and current a channel is delivering right now, plus power on SPD1000X. get_output reports what the channel is set to instead. Values are plain decimals without units. The first reading taken right after an output switch can still answer the previous value, so read again after a moment when it matters.

- Safety: Read-only
- Inputs:
  - `channel` (required): Programmable channel. Accepted values `"CH1"`, `"CH2"`. Default `"CH1"`.

<a id="tool-power-supply-get-output"></a>
### `get_output`

Read the configured voltage and current limit of CH1 or CH2 without changing them. This is what the channel is set to. measure_output reports what it is delivering. The fixed CH3 of the SPD3303 set is not programmable and has no setpoint.

- Safety: Read-only
- Inputs:
  - `channel` (required): Programmable channel. Accepted values `"CH1"`, `"CH2"`. Default `"CH1"`.

<a id="tool-power-supply-configure-output"></a>
### `configure_output`

Set and read back the output voltage or current limit for CH1 or CH2. Optionally select 2-wire or 4-wire remote sense on SPD1000X. Wire mode has no query form. Values above the known model rating are rejected before anything is sent.

- Safety: Setup change
- Inputs:
  - `channel` (required): Programmable channel. Accepted values `"CH1"`, `"CH2"`. Default `"CH1"`.
  - `voltage` (optional): Output voltage in volts. Minimum 0. Maximum 100.
  - `current` (optional): Output current limit in amperes. Minimum 0. Maximum 100.
  - `wire_mode` (optional): 2-wire or 4-wire remote sense operation. Accepted values `"2W"`, `"4W"`.

<a id="tool-power-supply-set-output"></a>
### `set_output`

Turn CH1, CH2, or the fixed CH3 output on or off. CH3 is available on SPD3303 only and cannot be programmed. Optionally toggle the waveform display on SPD1000X. These settings have no query form.

- Safety: Setup change
- Inputs:
  - `channel` (required): Output channel. CH3 is available on SPD3303 only. Accepted values `"CH1"`, `"CH2"`, `"CH3"`. Default `"CH1"`.
  - `enabled` (optional): Turn the channel output on or off.
  - `wave` (optional): Show or hide the waveform display for the channel.

<a id="tool-power-supply-set-track-mode"></a>
### `set_track_mode`

Select independent, series, or parallel operation for CH1 and CH2. Available on SPD3303 only. The command has no query form. get_power_status reports the active mode.

- Safety: Setup change
- Inputs:
  - `mode` (required): How CH1 and CH2 operate. Accepted values `"independent"`, `"series"`, `"parallel"`.

<a id="tool-power-supply-configure-protection"></a>
### `configure_protection`

Set and read back the over-voltage and over-current protection thresholds. Values are plain decimals. Available on SPD1000X only.

- Safety: Setup change
- Inputs:
  - `over_voltage` (optional): Over-voltage protection threshold in volts. Minimum 0. Maximum 100.
  - `over_current` (optional): Over-current protection threshold in amperes. Minimum 0. Maximum 100.

<a id="tool-power-supply-clear-protection"></a>
### `clear_protection`

Clear the over-voltage or over-current protection pop-up. Available on SPD1000X only. The command has no query form.

- Safety: Setup change
- Inputs: none

<a id="tool-power-supply-configure-timer"></a>
### `configure_timer`

Program up to five CH1 timer groups and optionally turn the timer on or off. Available on SPD1000X only. Groups run in numerical order starting with group 1. Configured groups are read back, but the timer enable state has no query form.

- Safety: Setup change
- Inputs:
  - `groups` (optional): Timer groups to program.
  - `enabled` (optional): Turn the CH1 timer on or off.

<a id="tool-power-supply-configure-lan"></a>
### `configure_lan`

Configure the supply's static IPv4 settings or DHCP. Available on SPD1000X only. Set dhcp to false when applying static settings. Changing the IP address closes the current connection. Requires confirm_network: true. Nothing is sent otherwise.

- Safety: Destructive
- Inputs:
  - `address` (optional): Static IPv4 address.
  - `netmask` (optional): Subnet mask.
  - `gateway` (optional): Default gateway.
  - `dhcp` (optional): Use automatic network configuration.
  - `confirm_network` (required): Acknowledge that changing network settings may close this connection. Required value `true`.

## Unsupported instrument

<a id="tool-generic-identify"></a>
### `identify`

Identify the connected instrument and return its manufacturer, model, serial number, and firmware.

- Safety: Read-only
- Inputs: none

<a id="tool-generic-status"></a>
### `status`

Report the connection state, target address, and last known identity without contacting the instrument.

- Safety: Read-only
- Inputs: none

<a id="tool-generic-scpi-query"></a>
### `scpi_query`

Send a raw SCPI query and return its text response. This instrument has no typed tools, so consult its programming guide before sending a query. Some queries have side effects.

- Safety: Destructive
- Inputs:
  - `command` (required): SCPI query, for example '*IDN?'. Minimum length 1. Maximum length 256.
  - `timeout_ms` (optional): Response timeout in milliseconds. Minimum 100. Maximum 120000.

<a id="tool-generic-scpi-command"></a>
### `scpi_command`

Send a raw SCPI command without reading a response. This instrument has no typed tools, so consult its programming guide for the commands it takes.

- Safety: Destructive
- Inputs:
  - `command` (required): SCPI command, for example '*RST'. Minimum length 1. Maximum length 256.
