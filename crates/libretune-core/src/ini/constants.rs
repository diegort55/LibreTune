//! Constants section parser
//!
//! Parses the [Constants] section which defines editable ECU parameters.

use super::split_ini_line;
use super::types::{DataType, DynamicSizeRefs, Endianness, Shape};
use serde::{Deserialize, Serialize};

/// Which OutputChannel a §5.1 "specialized PcVariable" tracks, and when -
/// `pcVariableName = channelValueOnConnect, chan` / `= continuousChannelValue,
/// chan`. Distinct from a plain PcVariable: its value comes from an
/// OutputChannel rather than direct user entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChannelTrackingMode {
    /// Captured once when a controller connection is made.
    OnConnect,
    /// Kept in sync with the channel for the whole communication session.
    Continuous,
}

/// A constant/parameter definition from the INI file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Constant {
    /// Constant name/identifier
    pub name: String,

    /// Human-readable label
    pub label: Option<String>,

    /// ECU page number (0-indexed)
    pub page: u8,

    /// Byte offset within page
    pub offset: u16,

    /// Data type
    pub data_type: DataType,

    /// Per-field endianness override (from BU08, BS16, etc. types)
    /// If None, use global ECU endianness
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endianness_override: Option<Endianness>,

    /// Shape (scalar, 1D, 2D)
    pub shape: Shape,

    /// For bits type: starting bit index from INI `[start:end]`
    pub bit_position: Option<u8>,

    /// For bits type: bit count (`end - start + 1` from INI `[start:end]`)
    pub bit_size: Option<u8>,

    /// For bits type: display offset (e.g., +1 means raw 0 displays as 1)
    /// Used in notations like [4:7+1] where the +1 is added to displayed value
    pub display_offset: i8,

    /// Unit of measurement
    pub units: String,

    /// Scale factor (multiply raw by this)
    pub scale: f64,

    /// Translation offset (add this after scaling)
    pub translate: f64,

    /// Minimum allowed value (display units)
    pub min: f64,

    /// Maximum allowed value (display units)
    pub max: f64,

    /// Number of decimal digits for display
    pub digits: u8,

    /// Tooltip/help text
    pub help: Option<String>,

    /// Condition expression for visibility
    pub visibility_condition: Option<String>,

    /// For bits type: option labels (e.g., ["Off", "On"])
    pub bit_options: Vec<String>,

    /// Whether this is a PC variable (stored locally, not on ECU)
    pub is_pc_variable: bool,

    /// Present when the INI sizes this array with `{const}` refs (resizable tables).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dynamic_size: Option<DynamicSizeRefs>,

    /// Raw INI text of the scale field when it is an expression rather than a
    /// literal, e.g. Speeduino's `{fuelLoadRes}` (which resolves to 2.0 or 0.5
    /// depending on the `algorithm` constant). Such a field cannot be resolved
    /// at parse time because it depends on tune values, so the expression is
    /// kept here and applied by [`resolve_dynamic_scale`] once those are known.
    /// Without it the field silently fell back to 1.0 and every affected axis
    /// displayed raw storage units (a Speeduino load axis read 8-50 instead of
    /// 16-100 kPa).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale_expr: Option<String>,

    /// Same as [`Constant::scale_expr`], for the translate field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translate_expr: Option<String>,

    /// `noMsqSave` last-attribute (or `[ConstantExtensions] noMsqSave = name`):
    /// never load this constant's value from a calibration/MSQ file - it
    /// always starts from its default/live value instead.
    #[serde(default)]
    pub no_msq_save: bool,

    /// `controllerPriority` last-attribute (or `[ConstantExtensions]
    /// controllerPriority = name`): can be saved/loaded offline, but a live
    /// controller's value always silently wins over any stored one once
    /// connected - e.g. a learned table like Long Term Fuel Trim, where a
    /// saved tune's copy is stale the moment the ECU is running.
    #[serde(default)]
    pub controller_priority: bool,

    /// Present for §5.1 specialized PcVariables (`pcVariableName =
    /// channelValueOnConnect, chan` / `= continuousChannelValue, chan`):
    /// which OutputChannel this PcVariable mirrors, and how often. Before
    /// this was recognized, `DataType::from_ini_str` was handed the channel
    /// name in place of a type keyword, failed, and the whole line was
    /// dropped - the PcVariable never existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracks_output_channel: Option<(String, ChannelTrackingMode)>,
}

/// Extract a deferred expression from an INI numeric field.
///
/// Returns `Some(expr)` when the field is a `{...}` expression that cannot be
/// parsed as a literal, and `None` when it is a plain number (or empty).
pub fn deferred_expr(field: &str) -> Option<String> {
    let t = field.trim();
    if t.parse::<f64>().is_ok() {
        return None;
    }
    let inner = t.strip_prefix('{')?.strip_suffix('}')?.trim();
    (!inner.is_empty()).then(|| inner.to_string())
}

impl Constant {
    /// Create a new scalar constant with defaults
    pub fn new(name: impl Into<String>, page: u8, offset: u16, data_type: DataType) -> Self {
        Self {
            name: name.into(),
            label: None,
            page,
            offset,
            data_type,
            endianness_override: None,
            shape: Shape::Scalar,
            bit_position: None,
            bit_size: None,
            display_offset: 0,
            units: String::new(),
            scale: 1.0,
            translate: 0.0,
            min: 0.0,
            max: 255.0,
            digits: 0,
            help: None,
            visibility_condition: None,
            bit_options: Vec::new(),
            is_pc_variable: false,
            dynamic_size: None,
            scale_expr: None,
            translate_expr: None,
            no_msq_save: false,
            controller_priority: false,
            tracks_output_channel: None,
        }
    }

    /// Total size in bytes for this constant
    pub fn size_bytes(&self) -> usize {
        if self.data_type == DataType::Bits {
            // Bits don't take extra space, they're packed
            0
        } else if self.data_type == DataType::String {
            // Strings have their length stored in shape (1 byte per character)
            self.shape.element_count()
        } else {
            self.data_type.size_bytes() * self.shape.element_count()
        }
    }

    /// Convert a raw value to display value
    pub fn raw_to_display(&self, raw: f64) -> f64 {
        raw * self.scale + self.translate
    }

    /// Convert a display value to raw value
    pub fn display_to_raw(&self, display: f64) -> f64 {
        (display - self.translate) / self.scale
    }

    /// Check if a display value is within allowed range
    pub fn is_in_range(&self, display_value: f64) -> bool {
        display_value >= self.min && display_value <= self.max
    }
}

impl Default for Constant {
    fn default() -> Self {
        Self {
            name: String::new(),
            label: None,
            page: 0,
            offset: 0,
            data_type: DataType::U08,
            endianness_override: None,
            shape: Shape::Scalar,
            bit_position: None,
            bit_size: None,
            display_offset: 0,
            units: String::new(),
            scale: 1.0,
            translate: 0.0,
            min: 0.0,
            max: 255.0,
            digits: 0,
            help: None,
            visibility_condition: None,
            bit_options: Vec::new(),
            is_pc_variable: false,
            dynamic_size: None,
            scale_expr: None,
            translate_expr: None,
            no_msq_save: false,
            controller_priority: false,
            tracks_output_channel: None,
        }
    }
}

/// Parse a constant definition line from INI
///
/// Format: name = class, type, offset, shape, units, scale, translate, min, max, digits
/// Note: Uses split_ini_line to properly handle expressions with commas inside braces,
/// such as: { bitStringValue(algorithmUnits , algorithm) }
/// The last_offset parameter supports the "lastOffset" keyword which means "use running offset counter"
/// Supports per-field big-endian types (BU08, BS16, etc.) that override global endianness.
/// The help parameter is the extracted help text from the field name (if any).
pub fn parse_constant_line(
    name: &str,
    value: &str,
    page: u8,
    last_offset: u16,
    help: Option<String>,
) -> Option<Constant> {
    let parts_vec = split_ini_line(value);
    let parts: Vec<&str> = parts_vec.iter().map(|s| s.as_str()).collect();

    if parts.len() < 3 {
        return None;
    }

    // parts[0] = class (scalar, array, bits)
    // parts[1] = type (U08, S16, BU16, etc. - B* types force big-endian)
    // parts[2] = offset (can be numeric or "lastOffset" keyword)

    let class = parts[0].to_lowercase();
    let (data_type, endianness_override) = DataType::from_ini_str_with_endianness(parts[1])?;

    // Handle "lastOffset" keyword - use the running offset counter
    let offset: u16 = if parts[2].trim().to_lowercase() == "lastoffset" {
        last_offset
    } else {
        parts[2].parse().ok()?
    };

    let mut constant = Constant::new(name, page, offset, data_type);
    constant.endianness_override = endianness_override;
    constant.help = help;

    // Parse shape based on class and remaining parts
    if class == "bits" {
        constant.data_type = DataType::Bits;
        // Format: bits, U08, offset, [start:end+display_offset], "Option1", ...
        // TunerStudio bit ranges are inclusive start:end (not position:size).
        // Examples: [6:6] → 1 bit at 6; [0:3] → 4 bits; [4:7+1] → 4 bits, display+1
        if parts.len() > 3 {
            if let Some((start, size, display_offset)) = parse_bit_range_spec(parts[3]) {
                constant.bit_position = Some(start);
                constant.bit_size = Some(size);
                constant.display_offset = display_offset;
            }
        }
        // Collect bit options (everything after the bit spec) - the labels
        // for each possible value (e.g., "Off", "On"). Each token is either
        // a plain "Label" (goes at the next sequential index) or the
        // shorthand `N="Label"` (places it at bit-value N and resumes
        // sequential numbering from N+1), used for long option lists with
        // gaps instead of writing out every "INVALID" filler by hand -
        // e.g. rusEFI's `engineType` selector: `22="BMW_M52"`.
        let mut next_index: usize = 0;
        for part in parts.iter().skip(4) {
            let trimmed = part.trim();
            if trimmed.is_empty() || trimmed.starts_with('{') {
                // Skip empty options and visibility conditions
                continue;
            }
            let (index, label) = match trimmed.split_once('=') {
                Some((index_str, label_part)) if index_str.trim().parse::<usize>().is_ok() => (
                    index_str.trim().parse::<usize>().unwrap(),
                    label_part.trim().trim_matches('"').to_string(),
                ),
                _ => (next_index, trimmed.trim_matches('"').to_string()),
            };
            while constant.bit_options.len() < index {
                constant.bit_options.push("INVALID".to_string());
            }
            if constant.bit_options.len() == index {
                constant.bit_options.push(label);
            } else {
                constant.bit_options[index] = label;
            }
            next_index = index + 1;
        }
        return Some(constant);
    } else if class == "array" && parts.len() > 3 {
        let (shape, dyn_refs) = Shape::parse_with_dynamic(parts[3]);
        constant.shape = shape;
        constant.dynamic_size = dyn_refs;
    } else if class == "string" && parts.len() > 3 {
        // String constants: name = string, ASCII, offset, length
        // The 4th field is the length in bytes
        if let Ok(length) = parts[3].trim().parse::<usize>() {
            constant.shape = Shape::Array1D(length);
        }
    }

    // Parse units (index 4 for bits/array, 3 for scalar)
    let units_idx = if class == "bits" || class == "array" {
        4
    } else {
        3
    };
    if parts.len() > units_idx {
        constant.units = parts[units_idx].trim_matches('"').to_string();
    }

    // Parse scale, translate, min, max, digits.
    // scale/translate may be `{expr}` referencing other constants (Speeduino's
    // `{fuelLoadRes}`); those are kept for deferred resolution instead of
    // silently collapsing to the literal fallback.
    let scale_idx = units_idx + 1;
    if parts.len() > scale_idx {
        constant.scale_expr = deferred_expr(parts[scale_idx]);
        constant.scale = parts[scale_idx].parse().unwrap_or(1.0);
    }
    if parts.len() > scale_idx + 1 {
        constant.translate_expr = deferred_expr(parts[scale_idx + 1]);
        constant.translate = parts[scale_idx + 1].parse().unwrap_or(0.0);
    }
    if parts.len() > scale_idx + 2 {
        constant.min = parts[scale_idx + 2].parse().unwrap_or(0.0);
    }
    if parts.len() > scale_idx + 3 {
        constant.max = parts[scale_idx + 3].parse().unwrap_or(255.0);
    }
    if parts.len() > scale_idx + 4 {
        constant.digits = parts[scale_idx + 4].parse().unwrap_or(0);
    }
    apply_last_attribute_keywords(&mut constant, &parts[(scale_idx + 5).min(parts.len())..]);

    Some(constant)
}

/// Parse a PcVariable constant line (no offset field)
/// Format: name = class, type, units, scale, translate, min, max, digits
/// or: name = bits, U08, [bit_spec], "Option1", "Option2", ...
/// PcVariables are stored locally (not on ECU), so they use page 255 and offset 0
/// The help parameter is the extracted help text from the field name (if any).
pub fn parse_pc_variable_line(name: &str, value: &str, help: Option<String>) -> Option<Constant> {
    let parts_vec = split_ini_line(value);
    let parts: Vec<&str> = parts_vec.iter().map(|s| s.as_str()).collect();

    if parts.len() < 2 {
        return None;
    }

    // parts[0] = class (scalar, array, bits)
    // parts[1] = type (U08, S16, etc)
    // NO offset for PcVariables

    let class = parts[0].to_lowercase();

    // §5.1 specialized PcVariables: `pcVariableName = channelValueOnConnect,
    // referencedOutputChannel` / `= continuousChannelValue, referencedOutputChannel`.
    // parts[1] here is the tracked channel's *name*, not a DataType keyword -
    // falling through to `DataType::from_ini_str(parts[1])?` below would
    // always fail on it and drop the whole PcVariable.
    if class == "channelvalueonconnect" || class == "continuouschannelvalue" {
        let mut constant = Constant::new(name, 255, 0, DataType::F32);
        constant.is_pc_variable = true;
        constant.help = help;
        if let Some(channel) = parts.get(1) {
            let mode = if class == "continuouschannelvalue" {
                ChannelTrackingMode::Continuous
            } else {
                ChannelTrackingMode::OnConnect
            };
            constant.tracks_output_channel = Some((channel.trim().to_string(), mode));
        }
        return Some(constant);
    }

    let data_type = DataType::from_ini_str(parts[1])?;

    // Use page 255 to indicate PC variable (not stored on ECU)
    let mut constant = Constant::new(name, 255, 0, data_type);
    constant.is_pc_variable = true;
    constant.help = help;

    // Parse based on class
    if class == "bits" {
        constant.data_type = DataType::Bits;
        // Format: bits, U08, [start:end+display_offset], "Option1", ...
        if parts.len() > 2 {
            if let Some((start, size, display_offset)) = parse_bit_range_spec(parts[2]) {
                constant.bit_position = Some(start);
                constant.bit_size = Some(size);
                constant.display_offset = display_offset;
            }
        }
        // Collect bit options
        for part in parts.iter().skip(3) {
            let opt = part.trim().trim_matches('"').to_string();
            if !opt.is_empty() && !opt.starts_with('{') {
                constant.bit_options.push(opt);
            }
        }
        return Some(constant);
    } else if class == "array" && parts.len() > 2 {
        // Format: array, type, [shape], units, scale, ...
        let (shape, dyn_refs) = Shape::parse_with_dynamic(parts[2]);
        constant.shape = shape;
        constant.dynamic_size = dyn_refs;
        // Parse units starting at index 3
        if parts.len() > 3 {
            constant.units = parts[3].trim_matches('"').to_string();
        }
        if parts.len() > 4 {
            constant.scale = parts[4].parse().unwrap_or(1.0);
        }
        if parts.len() > 5 {
            constant.translate = parts[5].parse().unwrap_or(0.0);
        }
        if parts.len() > 6 {
            constant.min = parts[6].parse().unwrap_or(0.0);
        }
        if parts.len() > 7 {
            constant.max = parts[7].parse().unwrap_or(255.0);
        }
        if parts.len() > 8 {
            constant.digits = parts[8].parse().unwrap_or(0);
        }
        apply_last_attribute_keywords(&mut constant, &parts[9.min(parts.len())..]);
        return Some(constant);
    }

    // Scalar format: scalar, type, units, scale, translate, min, max, digits
    if parts.len() > 2 {
        constant.units = parts[2].trim_matches('"').to_string();
    }
    if parts.len() > 3 {
        constant.scale = parts[3].parse().unwrap_or(1.0);
    }
    if parts.len() > 4 {
        constant.translate = parts[4].parse().unwrap_or(0.0);
    }
    if parts.len() > 5 {
        constant.min = parts[5].parse().unwrap_or(0.0);
    }
    if parts.len() > 6 {
        constant.max = parts[6].parse().unwrap_or(255.0);
    }
    if parts.len() > 7 {
        constant.digits = parts[7].parse().unwrap_or(0);
    }
    apply_last_attribute_keywords(&mut constant, &parts[8.min(parts.len())..]);

    Some(constant)
}

/// §4.5 last-attribute keywords appended after `digits` on a Constant or
/// PcVariable line (or `[ConstantExtensions] noMsqSave = name` / `=
/// controllerPriority = name`, applied separately - see
/// `parse_constants_extensions_entry`).
fn apply_last_attribute_keywords(constant: &mut Constant, trailing: &[&str]) {
    for part in trailing {
        let trimmed = part.trim();
        if trimmed.eq_ignore_ascii_case("noMsqSave") {
            constant.no_msq_save = true;
        } else if trimmed.eq_ignore_ascii_case("controllerPriority") {
            constant.controller_priority = true;
        }
    }
}

/// Parse TunerStudio bit range `[start:end]` or `[start:end+N]` / `[start:end-N]`.
/// Returns `(start_bit, bit_count, display_offset)` where `bit_count = end - start + 1`.
fn parse_bit_range_spec(spec: &str) -> Option<(u8, u8, i8)> {
    let bit_spec = spec.trim().trim_matches(|c| c == '[' || c == ']');
    let bit_parts: Vec<&str> = bit_spec.split(':').collect();
    if bit_parts.is_empty() {
        return None;
    }
    let start: u8 = bit_parts[0].parse().ok()?;
    if bit_parts.len() < 2 {
        return Some((start, 1, 0));
    }

    let end_part = bit_parts[1];
    let (end, display_offset) = if let Some(plus_pos) = end_part.find('+') {
        let end: u8 = end_part[..plus_pos].parse().ok()?;
        let offset = end_part[plus_pos + 1..].parse().unwrap_or(0);
        (end, offset)
    } else if let Some(minus_pos) = end_part.rfind('-') {
        // rfind avoids treating a leading '-' on a negative index as an offset
        if minus_pos > 0 {
            let end: u8 = end_part[..minus_pos].parse().ok()?;
            let offset = -(end_part[minus_pos + 1..].parse::<i8>().unwrap_or(0));
            (end, offset)
        } else {
            (end_part.parse().ok()?, 0)
        }
    } else {
        (end_part.parse().ok()?, 0)
    };

    let size = if end >= start { end - start + 1 } else { 1 };
    Some((start, size, display_offset))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_constant_new() {
        let c = Constant::new("test", 0, 100, DataType::U16);
        assert_eq!(c.name, "test");
        assert_eq!(c.offset, 100);
        assert_eq!(c.data_type, DataType::U16);
    }

    #[test]
    fn test_raw_display_conversion() {
        let mut c = Constant::new("afr", 0, 0, DataType::U08);
        c.scale = 0.1;
        c.translate = 0.0;

        assert!((c.raw_to_display(147.0) - 14.7).abs() < 0.01);
        assert!((c.display_to_raw(14.7) - 147.0).abs() < 0.01);
    }

    #[test]
    fn test_parse_constant_line_scalar() {
        let c = parse_constant_line(
            "reqFuel",
            "scalar, U16, 0, \"ms\", 0.1, 0.0, 0, 25.5, 1",
            0,
            0,
            None,
        );
        assert!(c.is_some());
        let c = c.unwrap();
        assert_eq!(c.name, "reqFuel");
        assert_eq!(c.data_type, DataType::U16);
        assert_eq!(c.offset, 0);
        assert!((c.scale - 0.1).abs() < 0.001);
    }

    #[test]
    fn test_parse_constant_line_lastoffset() {
        // Test the lastOffset keyword - should use the provided last_offset value
        let c = parse_constant_line(
            "afrTable",
            "array, U08, lastOffset, [16x16], \"AFR\", 0.1, 0.0, 7, 25.5, 1",
            0,
            1234,
            None,
        );
        assert!(c.is_some());
        let c = c.unwrap();
        assert_eq!(c.name, "afrTable");
        assert_eq!(c.data_type, DataType::U08);
        assert_eq!(c.offset, 1234); // Should use the last_offset value
        assert_eq!(c.shape, Shape::Array2D { rows: 16, cols: 16 });
    }

    #[test]
    fn test_parse_pc_variable_line_scalar() {
        // Test PC variable scalar parsing (no offset)
        let c = parse_pc_variable_line("rpmwarn", "scalar, U16, \"rpm\", 1, 0, 0, 30000, 0", None);
        assert!(c.is_some());
        let c = c.unwrap();
        assert_eq!(c.name, "rpmwarn");
        assert_eq!(c.data_type, DataType::U16);
        assert_eq!(c.page, 255); // PC variable marker
        assert_eq!(c.offset, 0);
        assert!(c.is_pc_variable);
        assert_eq!(c.units, "rpm");
        assert!((c.max - 30000.0).abs() < 0.01);
    }

    #[test]
    fn test_parse_pc_variable_line_bits() {
        // Test PC variable bits parsing
        let c = parse_pc_variable_line(
            "tsCanId",
            "bits, U08, [0:3], \"CAN ID 0\", \"CAN ID 1\", \"CAN ID 2\"",
            None,
        );
        assert!(c.is_some());
        let c = c.unwrap();
        assert_eq!(c.name, "tsCanId");
        assert_eq!(c.data_type, DataType::Bits);
        assert!(c.is_pc_variable);
        assert_eq!(c.bit_position, Some(0));
        assert_eq!(c.bit_size, Some(4)); // [0:3] inclusive → 4 bits
        assert_eq!(c.bit_options.len(), 3);
        assert_eq!(c.bit_options[0], "CAN ID 0");
        assert_eq!(c.display_offset, 0); // No offset
    }

    #[test]
    fn test_parse_bits_single_bit() {
        // consumeObdSensors-style flag: [6:6] is one bit at position 6
        let c = parse_constant_line(
            "consumeObdSensors",
            "bits, U08, 10, [6:6], \"false\", \"true\"",
            0,
            0,
            None,
        );
        assert!(c.is_some());
        let c = c.unwrap();
        assert_eq!(c.bit_position, Some(6));
        assert_eq!(c.bit_size, Some(1));
    }

    #[test]
    fn test_parse_bits_with_display_offset_positive() {
        // Test [4:7+1] notation - bits 4..=7 with display offset of +1
        let c = parse_constant_line("nCylinders", "bits, U08, 182, [4:7+1]", 0, 0, None);
        assert!(c.is_some());
        let c = c.unwrap();
        assert_eq!(c.name, "nCylinders");
        assert_eq!(c.data_type, DataType::Bits);
        assert_eq!(c.bit_position, Some(4));
        assert_eq!(c.bit_size, Some(4)); // [4:7] inclusive → 4 bits
        assert_eq!(c.display_offset, 1); // +1 display offset
    }

    #[test]
    fn test_parse_bits_with_display_offset_negative() {
        // Test [0:3-1] notation - bits 0..=3 with display offset of -1
        let c = parse_constant_line(
            "someField",
            "bits, U08, 100, [0:3-1], \"Val 0\", \"Val 1\"",
            0,
            0,
            None,
        );
        assert!(c.is_some());
        let c = c.unwrap();
        assert_eq!(c.name, "someField");
        assert_eq!(c.bit_position, Some(0));
        assert_eq!(c.bit_size, Some(4)); // [0:3] inclusive → 4 bits
        assert_eq!(c.display_offset, -1); // -1 display offset
        assert_eq!(c.bit_options.len(), 2);
    }

    #[test]
    fn test_parse_bits_without_display_offset() {
        // Test [0:7] notation - full byte, no display offset
        let c = parse_constant_line(
            "normalBits",
            "bits, U08, 50, [0:7], \"Off\", \"On\"",
            0,
            0,
            None,
        );
        assert!(c.is_some());
        let c = c.unwrap();
        assert_eq!(c.bit_position, Some(0));
        assert_eq!(c.bit_size, Some(8)); // [0:7] inclusive → 8 bits
        assert_eq!(c.display_offset, 0); // No offset
    }

    #[test]
    fn test_parse_bits_with_invalid_options() {
        // Test that INVALID options are still collected (filtering happens in frontend)
        let c = parse_constant_line(
            "strategy",
            "bits, U08, 10, [2:3], \"Basic\", \"INVALID\", \"INVALID\", \"Advanced\"",
            0,
            0,
            None,
        );
        assert!(c.is_some());
        let c = c.unwrap();
        assert_eq!(c.bit_options.len(), 4);
        assert_eq!(c.bit_options[0], "Basic");
        assert_eq!(c.bit_options[1], "INVALID");
        assert_eq!(c.bit_options[2], "INVALID");
        assert_eq!(c.bit_options[3], "Advanced");
    }

    /// rusEFI's `engineType` selector (the board/engine picker, one of the
    /// most central fields in the INI) uses this shorthand for its ~105
    /// sparse options rather than writing out every "INVALID" filler by
    /// hand: `22="BMW_M52"`. The old parser only trim_matches('"') on each
    /// token - which does nothing at the *start* of `22="BMW_M52"` since it
    /// doesn't begin with a quote - so it pushed the literal garbage
    /// `22="BMW_M52` at the next sequential slot instead of "BMW_M52" at
    /// index 22, corrupting every option's index from that point on.
    #[test]
    fn test_parse_bits_with_indexed_option_shorthand() {
        let c = parse_constant_line(
            "engineType",
            "bits, U32, 0, [0:6], 1=\"Option 1\", 3=\"Option 2\"",
            0,
            0,
            None,
        );
        assert!(c.is_some());
        let c = c.unwrap();
        assert_eq!(
            c.bit_options,
            vec!["INVALID", "Option 1", "INVALID", "Option 2"]
        );
    }

    /// Sequential numbering resumes after an explicit index, matching the
    /// spec's stated equivalence for `1="Option 1", 3="Option 2"`.
    #[test]
    fn test_parse_bits_indexed_shorthand_resumes_sequential_numbering() {
        let c = parse_constant_line(
            "mixedOptions",
            "bits, U08, 0, [0:2], \"Zero\", 5=\"Five\", \"Six\"",
            0,
            0,
            None,
        );
        assert!(c.is_some());
        let c = c.unwrap();
        assert_eq!(
            c.bit_options,
            vec!["Zero", "INVALID", "INVALID", "INVALID", "INVALID", "Five", "Six"]
        );
    }

    /// rusEFI's real INI: Long Term Fuel Trim is a *learned* table the ECU
    /// updates live, so its INI entry marks both flags -
    /// `noMsqSave,controllerPriority` (§4.5) - meaning a saved tune's copy
    /// is never trusted: never loaded from a calibration file, and any
    /// online value always silently wins. Neither flag was parsed at all.
    #[test]
    fn test_parse_last_attribute_keywords_no_msq_save_and_controller_priority() {
        let c = parse_constant_line(
            "ltft_table_bank1",
            "array, F32, 0, [16x16], \"%\", 100.0, 0.00000, -35.0, 35.0, 1, noMsqSave,controllerPriority",
            0,
            0,
            None,
        );
        assert!(c.is_some());
        let c = c.unwrap();
        assert!(c.no_msq_save);
        assert!(c.controller_priority);
    }

    /// A constant without either trailing keyword must not have them
    /// inferred - both stay false.
    #[test]
    fn test_parse_last_attribute_keywords_absent_by_default() {
        let c = parse_constant_line("plainConst", "scalar, U08, 10, \"\", 1, 0, 0, 255, 0", 0, 0, None);
        assert!(c.is_some());
        let c = c.unwrap();
        assert!(!c.no_msq_save);
        assert!(!c.controller_priority);
    }

    /// PcVariables carry the same trailing keywords - rusEFI's real
    /// `veLoadSrc = scalar, U08, "", 1, 0, 0, 5, 0, noMsqSave`.
    #[test]
    fn test_parse_pc_variable_no_msq_save() {
        let c = parse_pc_variable_line("veLoadSrc", "scalar, U08, \"\", 1, 0, 0, 5, 0, noMsqSave", None);
        assert!(c.is_some());
        let c = c.unwrap();
        assert!(c.no_msq_save);
        assert!(!c.controller_priority);
    }

    /// rusEFI's real INI: `tuneCrcPcVariable = continuousChannelValue,
    /// tuneCrc16`. Before this, `DataType::from_ini_str("tuneCrc16")` failed
    /// (it's a channel name, not a type keyword) and the whole PcVariable
    /// was silently dropped via the `?` early-return.
    #[test]
    fn test_parse_pc_variable_continuous_channel_value() {
        let c = parse_pc_variable_line("tuneCrcPcVariable", "continuousChannelValue, tuneCrc16", None);
        assert!(c.is_some(), "must parse instead of being silently dropped");
        let c = c.unwrap();
        assert!(c.is_pc_variable);
        assert_eq!(
            c.tracks_output_channel,
            Some(("tuneCrc16".to_string(), ChannelTrackingMode::Continuous))
        );
    }

    #[test]
    fn test_parse_pc_variable_channel_value_on_connect() {
        let c = parse_pc_variable_line("someVar", "channelValueOnConnect, someChannel", None);
        assert!(c.is_some());
        let c = c.unwrap();
        assert_eq!(
            c.tracks_output_channel,
            Some(("someChannel".to_string(), ChannelTrackingMode::OnConnect))
        );
    }
}
