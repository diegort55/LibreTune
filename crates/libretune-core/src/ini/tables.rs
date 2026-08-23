//! Table editor definitions parser
//!
//! Parses [TableEditor] sections which define 2D/3D table editing interfaces.

use serde::{Deserialize, Serialize};

/// A table editor definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableDefinition {
    /// Table name/identifier
    pub name: String,

    /// Map name used in menu references (from table = tableName, mapName, ...)
    /// Menus reference tables by this map_name, not the name field
    pub map_name: Option<String>,

    /// Display title
    pub title: String,

    /// Table type (2D or 3D)
    pub table_type: TableType,

    /// Main map/data constant name
    pub map: String,

    /// X-axis constant name (bins)
    pub x_bins: String,

    /// X-axis output channel for highlighting
    pub x_output_channel: Option<String>,

    /// X bins are a fixed reference axis the INI marks `readOnly` (e.g. Long
    /// Term Fuel Trim tracking the VE table's own RPM/load bins) - editing
    /// them here would desync from what they're meant to track.
    #[serde(default)]
    pub x_bins_read_only: bool,

    /// Y-axis constant name (bins) - only for 3D tables
    pub y_bins: Option<String>,

    /// Y-axis output channel for highlighting - only for 3D tables
    pub y_output_channel: Option<String>,

    /// See `x_bins_read_only`.
    #[serde(default)]
    pub y_bins_read_only: bool,

    /// Page number for the table data
    pub page: u8,

    /// Number of columns
    pub x_size: usize,

    /// Number of rows (1 for 2D tables)
    pub y_size: usize,

    /// Up-from color (high values)
    pub up_color: Option<String>,

    /// Down-from color (low values)
    pub down_color: Option<String>,

    /// Grid height for display
    pub grid_height: Option<f32>,

    /// Grid orientation
    pub grid_orient: Option<u8>,

    /// Help text
    pub help: Option<String>,

    /// X-axis label (from xyLabels)
    pub x_label: Option<String>,

    /// Y-axis label (from xyLabels)
    pub y_label: Option<String>,

    /// Functional role of this table, used by the AI assistant and other
    /// automation to know what a table *does* (e.g. VE table vs ignition
    /// table vs AFR target) without guessing from its name. Defaults to
    /// `Other`; populated by `EcuDefinition::infer_table_roles()`.
    #[serde(default)]
    pub role: TableRole,

    /// Row-count scalar for TunerStudio dynamically sized tables.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows_size_const: Option<String>,

    /// Column-count scalar for TunerStudio dynamically sized tables.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cols_size_const: Option<String>,

    /// Cell budget (`maximumElements`) when the table is resizable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_elements: Option<usize>,
}

/// Type of table
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TableType {
    /// 2D table (one axis)
    TwoD,
    /// 3D table (two axes)
    ThreeD,
}

/// Functional role of a table within the ECU tune.
///
/// Used by automation (e.g. the AI assistant) to reason about tables without
/// relying on name heuristics. Inferred from the INI's `[VeAnalyze]` /
/// `[WueAnalyze]` configuration where available; unknown tables default to
/// [`TableRole::Other`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum TableRole {
    /// Volumetric-efficiency (fuel) table — the primary table AutoTune modifies.
    Ve,
    /// Ignition / spark-advance table.
    Ignition,
    /// AFR / lambda target table used as the closed-loop setpoint.
    AfrTarget,
    /// Warm-up enrichment curve.
    WarmupEnrichment,
    /// Role could not be determined from the INI definition.
    #[default]
    Other,
}

impl TableDefinition {
    /// Create a new 2D table definition
    pub fn new_2d(
        name: impl Into<String>,
        map: impl Into<String>,
        x_bins: impl Into<String>,
        x_size: usize,
    ) -> Self {
        Self {
            name: name.into(),
            map_name: None,
            title: String::new(),
            table_type: TableType::TwoD,
            map: map.into(),
            x_bins: x_bins.into(),
            x_output_channel: None,
            x_bins_read_only: false,
            y_bins: None,
            y_output_channel: None,
            y_bins_read_only: false,
            page: 0,
            x_size,
            y_size: 1,
            up_color: None,
            down_color: None,
            grid_height: None,
            grid_orient: None,
            help: None,
            x_label: None,
            y_label: None,
            role: TableRole::default(),
            rows_size_const: None,
            cols_size_const: None,
            max_elements: None,
        }
    }

    /// Create a new 3D table definition
    pub fn new_3d(
        name: impl Into<String>,
        map: impl Into<String>,
        x_bins: impl Into<String>,
        y_bins: impl Into<String>,
        x_size: usize,
        y_size: usize,
    ) -> Self {
        Self {
            name: name.into(),
            map_name: None,
            title: String::new(),
            table_type: TableType::ThreeD,
            map: map.into(),
            x_bins: x_bins.into(),
            x_output_channel: None,
            x_bins_read_only: false,
            y_bins: Some(y_bins.into()),
            y_output_channel: None,
            y_bins_read_only: false,
            page: 0,
            x_size,
            y_size,
            up_color: None,
            down_color: None,
            grid_height: None,
            grid_orient: None,
            help: None,
            x_label: None,
            y_label: None,
            role: TableRole::default(),
            rows_size_const: None,
            cols_size_const: None,
            max_elements: None,
        }
    }

    /// Check if this is a 3D table
    pub fn is_3d(&self) -> bool {
        self.table_type == TableType::ThreeD
    }

    /// True when the INI sizes this table with `{row}/{col}` scalars.
    pub fn is_resizable(&self) -> bool {
        self.rows_size_const.is_some() && self.cols_size_const.is_some()
    }

    /// Total number of cells in the table
    pub fn cell_count(&self) -> usize {
        self.x_size * self.y_size
    }
}

impl Default for TableDefinition {
    fn default() -> Self {
        Self::new_2d("", "", "", 0)
    }
}

/// A 2D curve editor definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurveDefinition {
    /// Curve name/identifier
    pub name: String,

    /// Display title
    pub title: String,

    /// X-axis constant name (bins)
    pub x_bins: String,

    /// X-axis output channel for highlighting
    pub x_output_channel: Option<String>,

    /// X bins are a fixed reference axis the INI marks `readOnly` (e.g. a
    /// blend curve tracking a table's own RPM/load bins) - editing them here
    /// would desync from what they're meant to track.
    pub x_bins_read_only: bool,

    /// Y-axis constant name (values)
    pub y_bins: String,

    /// See `x_bins_read_only`.
    pub y_bins_read_only: bool,

    /// Column labels (X label, Y label)
    pub column_labels: (String, String),

    /// X-axis range and step (min, max, step), each raw and possibly a
    /// braced expression (e.g. `{ cltHighXaxis }`) - resolved against a live
    /// numeric context when the curve's data is fetched, not at parse time.
    pub x_axis: Option<(String, String, String)>,

    /// Y-axis range and step (min, max, step); see `x_axis`.
    pub y_axis: Option<(String, String, String)>,

    /// Size (width, height) - number of points
    pub size: Option<usize>,

    /// Page number for the curve data
    pub page: u8,

    /// Help text
    pub help: Option<String>,

    /// Gauge name for live display (from gauge = GaugeName in INI)
    pub gauge: Option<String>,

    /// `lineLabel` matched to `y_bins` (the first/primary series) when a
    /// curve has more than one - see `additional_y_series`. rusEFI's
    /// `rangeMatrix` (11 series) writes every `yBins` line first and every
    /// `lineLabel` line after, in the same order, rather than interleaving
    /// them; labels are matched positionally across primary + additional in
    /// parse order, not by which yBins line they follow.
    #[serde(default)]
    pub primary_y_line_label: Option<String>,

    /// One yBins row is required (`y_bins`, above); §9.2.1 allows any number
    /// of additional rows, each another 1D array reference with an optional
    /// `{visibility expression}` and its own `lineLabel`, rendered as extra
    /// color-coded lines on the same chart (rusEFI's `shiftSpeedCurve` has
    /// 6, `rangeMatrix` has 11). A curve with only the required `yBins`
    /// leaves this empty.
    #[serde(default)]
    pub additional_y_series: Vec<CurveYSeries>,
}

/// One extra Y-axis array on a multi-series curve (`y_bins` on
/// [`CurveDefinition`] is always the first/primary series; this is series 2
/// and on). See [`CurveDefinition::additional_y_series`].
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CurveYSeries {
    /// The 1D array constant this series reads its values from.
    pub bins: String,
    /// Raw `{expression}` text (unevaluated - needs a live tune context,
    /// same as `x_axis`/`y_axis`) that decides whether this series is
    /// currently active/visible. `None` means always visible.
    pub visibility_expr: Option<String>,
    /// This series' own axis label, if the INI gave it one.
    pub line_label: Option<String>,
}

impl CurveDefinition {
    /// Create a new curve definition
    pub fn new(
        name: impl Into<String>,
        x_bins: impl Into<String>,
        y_bins: impl Into<String>,
    ) -> Self {
        Self {
            name: name.into(),
            title: String::new(),
            x_bins: x_bins.into(),
            x_output_channel: None,
            x_bins_read_only: false,
            y_bins: y_bins.into(),
            y_bins_read_only: false,
            column_labels: (String::new(), String::new()),
            x_axis: None,
            y_axis: None,
            size: None,
            page: 0,
            help: None,
            gauge: None,
            primary_y_line_label: None,
            additional_y_series: Vec::new(),
        }
    }
}

impl Default for CurveDefinition {
    fn default() -> Self {
        Self::new("", "", "")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_2d_table() {
        let table = TableDefinition::new_2d("cranking", "crankingTable", "crankingBins", 10);
        assert!(!table.is_3d());
        assert_eq!(table.cell_count(), 10);
    }

    #[test]
    fn test_3d_table() {
        let table =
            TableDefinition::new_3d("veTable1", "veTable1Map", "rpmBins", "fuelLoadBins", 16, 16);
        assert!(table.is_3d());
        assert_eq!(table.cell_count(), 256);
    }
}
