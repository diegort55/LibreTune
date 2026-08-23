//! Curve get/update commands.

use crate::commands::constant_values::collect_scalar_constant_values;
use crate::commands::string_context::{build_string_context, numeric_context_from_tune};
use crate::AppState;
use libretune_core::ini::expression::{evaluate_display_string, evaluate_numeric_string};
use libretune_core::ini::Constant;
use libretune_core::protocol::Connection;
use libretune_core::tune::TuneFile;
use serde::Serialize;

/// One extra Y-axis line on a multi-series curve (`y_bins` on [`CurveData`]
/// is always the first/primary series). See
/// `libretune_core::ini::CurveYSeries`.
#[derive(Serialize, Clone)]
pub struct CurveSeriesData {
    pub values: Vec<f64>,
    /// This series' own axis label, if the INI gave it one (`lineLabel`).
    pub label: Option<String>,
    /// Result of evaluating the series' `{visibility expression}` against
    /// the live tune - always `true` when the INI didn't give it one.
    pub visible: bool,
}

#[derive(Serialize)]
pub struct CurveData {
    pub name: String,
    pub title: String,
    pub x_bins: Vec<f64>,
    pub y_bins: Vec<f64>,
    pub x_label: String,
    pub y_label: String,
    /// `lineLabel` for the primary series - only meaningful when
    /// `additional_y_series` is non-empty (a single-series curve's label is
    /// just `y_label`).
    pub primary_y_line_label: Option<String>,
    /// §9.2.1: yBins rows beyond the required first one. Empty for the
    /// overwhelming majority of curves, which have exactly one Y series.
    pub additional_y_series: Vec<CurveSeriesData>,
    /// X-axis range: (min, max, step)
    pub x_axis: Option<(f32, f32, f32)>,
    /// Y-axis range: (min, max, step)
    pub y_axis: Option<(f32, f32, f32)>,
    /// Output channel name for live cursor (e.g., "coolant")
    pub x_output_channel: Option<String>,
    /// INI's xBins ... readOnly - this axis tracks a fixed reference (e.g. a
    /// blend curve's bins mirror the VE table's own RPM axis) and must not
    /// be edited from this view.
    pub x_bins_read_only: bool,
    /// See `x_bins_read_only`.
    pub y_bins_read_only: bool,
    /// Gauge name for live display
    pub gauge: Option<String>,
}
/// # Arguments
/// * `curve_name` - Curve name from INI definition
///
/// Returns: CurveData with x/y values and metadata
#[tauri::command]
pub async fn get_curve_data(
    state: tauri::State<'_, AppState>,
    curve_name: String,
) -> Result<CurveData, String> {
    let def_guard = state.definition.lock().await;
    let def = def_guard.as_ref().ok_or_else(|| {
        eprintln!(
            "[WARN] get_curve_data: Definition not loaded when looking for '{}'",
            curve_name
        );
        "Definition not loaded".to_string()
    })?;
    let endianness = def.endianness;

    // Diagnostic logging
    eprintln!(
        "[DEBUG] get_curve_data: Looking for '{}' in {} curves ({} map entries)",
        curve_name,
        def.curves.len(),
        def.curve_map_to_name.len()
    );

    let curve = def.get_curve_by_name_or_map(&curve_name).ok_or_else(|| {
        // Log available curves for debugging
        let available: Vec<_> = def.curves.keys().take(10).cloned().collect();
        eprintln!(
            "[WARN] get_curve_data: Curve '{}' not found. Available curves (first 10): {:?}",
            curve_name, available
        );
        format!(
            "Curve '{}' not found (checked {} curves, {} map entries)",
            curve_name,
            def.curves.len(),
            def.curve_map_to_name.len()
        )
    })?;

    eprintln!(
        "[DEBUG] get_curve_data: Found curve '{}' (title: {})",
        curve.name, curve.title
    );

    // Clone the constant info we need
    let x_const = def
        .constants
        .get(&curve.x_bins)
        .ok_or_else(|| format!("Constant {} not found", curve.x_bins))?
        .clone();
    let y_const = def
        .constants
        .get(&curve.y_bins)
        .ok_or_else(|| format!("Constant {} not found", curve.y_bins))?
        .clone();

    // §9.2.1: a curve can have any number of yBins beyond the required
    // first one, each another 1D array with its own optional visibility
    // expression and lineLabel - rendered as extra color-coded lines on the
    // same chart (rusEFI's shiftSpeedCurve has 6, rangeMatrix has 11). A
    // series whose constant is missing from the definition is dropped with
    // a warning rather than failing the whole curve.
    let additional_series_sources: Vec<(Constant, Option<String>, Option<String>)> = curve
        .additional_y_series
        .iter()
        .filter_map(|series| {
            let Some(constant) = def.constants.get(&series.bins) else {
                eprintln!(
                    "[WARN] get_curve_data: additional series constant '{}' not found for curve '{}', skipping",
                    series.bins, curve_name
                );
                return None;
            };
            Some((
                constant.clone(),
                series.visibility_expr.clone(),
                series.line_label.clone(),
            ))
        })
        .collect();

    // Clone curve metadata
    let curve_name_out = curve.name.clone();
    let curve_title = curve.title.clone();
    let x_label = curve.column_labels.0.clone();
    let y_label = curve.column_labels.1.clone();
    let primary_y_line_label = curve.primary_y_line_label.clone();
    let x_axis_raw = curve.x_axis.clone();
    let y_axis_raw = curve.y_axis.clone();
    let x_output_channel = curve.x_output_channel.clone();
    let x_bins_read_only = curve.x_bins_read_only;
    let y_bins_read_only = curve.y_bins_read_only;
    let gauge = curve.gauge.clone();

    drop(def_guard);

    // Helper to read constant data from TuneFile (offline) or ECU (online)
    fn read_const_from_source(
        constant: &Constant,
        tune: Option<&TuneFile>,
        conn: &mut Option<&mut Connection>,
        endianness: libretune_core::ini::Endianness,
    ) -> Result<Vec<f64>, String> {
        let element_count = constant.shape.element_count();
        let element_size = constant.data_type.size_bytes();
        let length = constant.size_bytes() as u16;

        eprintln!(
            "[DEBUG] read_const_from_source: '{}' - shape={:?}, element_count={}, element_size={}, total_length={}",
            constant.name, constant.shape, element_count, element_size, length
        );

        // If offline, read from TuneFile (MSQ file)
        if conn.is_none() {
            if let Some(tune_file) = tune {
                // First try named constants (parsed from MSQ <constant> tags)
                if let Some(tune_value) = tune_file.constants.get(&constant.name) {
                    use libretune_core::tune::TuneValue;
                    eprintln!(
                        "[DEBUG] read_const_from_source: '{}' found in TuneFile.constants",
                        constant.name
                    );
                    match tune_value {
                        TuneValue::Array(arr) => {
                            eprintln!("[DEBUG] read_const_from_source: '{}' returning {} array values from constants", constant.name, arr.len());
                            return Ok(arr.clone());
                        }
                        TuneValue::Scalar(v) => {
                            return Ok(vec![*v]);
                        }
                        _ => {}
                    }
                }

                // Fallback: try to read from raw page data using INI offset
                // This handles cases where the constant wasn't explicitly in the MSQ file
                if let Some(page_data) = tune_file.pages.get(&constant.page) {
                    let offset = constant.offset as usize;
                    let total_bytes = element_count * element_size;

                    if offset + total_bytes <= page_data.len() {
                        eprintln!("[DEBUG] read_const_from_source: '{}' reading from TuneFile.pages[{}] at offset {}", 
                            constant.name, constant.page, offset);

                        let mut values = Vec::with_capacity(element_count);
                        for i in 0..element_count {
                            let elem_offset = offset + i * element_size;
                            if let Some(raw_val) = constant.data_type.read_from_bytes(
                                page_data,
                                elem_offset,
                                endianness,
                            ) {
                                values.push(constant.raw_to_display(raw_val));
                            } else {
                                values.push(0.0);
                            }
                        }
                        eprintln!("[DEBUG] read_const_from_source: '{}' returning {} values from page data", constant.name, values.len());
                        return Ok(values);
                    } else {
                        eprintln!("[WARN] read_const_from_source: '{}' offset {} + size {} exceeds page {} length {}", 
                            constant.name, offset, total_bytes, constant.page, page_data.len());
                    }
                } else {
                    eprintln!("[WARN] read_const_from_source: '{}' page {} not found in TuneFile.pages (available: {:?})", 
                        constant.name, constant.page, tune_file.pages.keys().collect::<Vec<_>>());
                }
            }
            // If not found anywhere, return zeros
            eprintln!(
                "[DEBUG] read_const_from_source: '{}' returning {} zeros (not in TuneFile)",
                constant.name, element_count
            );
            return Ok(vec![0.0; element_count]);
        }

        // For ECU reads, we need valid length
        if length == 0 {
            eprintln!(
                "[WARN] read_const_from_source: '{}' has length=0, cannot read from ECU",
                constant.name
            );
            return Ok(vec![0.0; element_count]);
        }

        // If connected to ECU, read from ECU (live data)
        if let Some(ref mut conn_ptr) = conn {
            let params = libretune_core::protocol::commands::ReadMemoryParams {
                can_id: 0,
                page: constant.page,
                offset: constant.offset,
                length,
            };

            let raw_data = conn_ptr.read_memory(params).map_err(|e| e.to_string())?;

            let mut values = Vec::new();
            for i in 0..element_count {
                let offset = i * element_size;
                if let Some(raw_val) = constant
                    .data_type
                    .read_from_bytes(&raw_data, offset, endianness)
                {
                    values.push(constant.raw_to_display(raw_val));
                } else {
                    values.push(0.0);
                }
            }
            return Ok(values);
        }

        Ok(vec![0.0; element_count])
    }

    // Get tune and connection
    // Lock order: connection before current_tune, matching the convention used
    // by every write path (get_constant_value, update_constant, etc.) — the
    // reverse order deadlocks against those.
    let mut conn_guard = state.connection.lock().await;
    let tune_guard = state.current_tune.lock().await;
    let mut conn = conn_guard.as_mut();

    let x_bins = read_const_from_source(&x_const, tune_guard.as_ref(), &mut conn, endianness)?;
    let y_bins = read_const_from_source(&y_const, tune_guard.as_ref(), &mut conn, endianness)?;

    let mut additional_series_values: Vec<(Vec<f64>, Option<String>, Option<String>)> = Vec::new();
    for (constant, visibility_expr, line_label) in &additional_series_sources {
        let values = read_const_from_source(constant, tune_guard.as_ref(), &mut conn, endianness)?;
        additional_series_values.push((values, visibility_expr.clone(), line_label.clone()));
    }

    drop(conn_guard);
    drop(tune_guard);

    // column_labels can be a braced INI expression (e.g. bitStringValue(...))
    // rather than a literal string - resolve it the same way tables do.
    let string_ctx = build_string_context(&state).await;
    let numeric = {
        // Lock order matches get_gauge_config: definition -> cache -> tune.
        let def_guard = state.definition.lock().await;
        let cache_guard = state.tune_cache.lock().await;
        let tune = state.current_tune.lock().await;
        let mut base = numeric_context_from_tune(tune.as_ref());
        if let Some(def) = def_guard.as_ref() {
            // Many MSQs (and "Use LibreTune Settings" saves) store data as
            // raw pageData blobs rather than named <constant> tags, so a
            // constant like useMetricOnInterface - which an xAxis bound's
            // helper expression depends on - is absent from
            // numeric_context_from_tune above. Fill any such gaps from the
            // decoded page cache, the same source get_constant_value falls
            // back to for a single lookup.
            base.extend(collect_scalar_constant_values(
                def,
                tune.as_ref(),
                cache_guard.as_ref(),
            ));
            // xAxis/yAxis bounds and scale/translate fields often *name* a
            // computed output-channel helper (`{ iatHighXaxis }`) rather than
            // a real constant - resolve those into context too, or the bare
            // name evaluates to 0 (evaluate()'s default for an unknown
            // variable) instead of the helper's actual value.
            base = def.context_with_output_channel_helpers(&base);
        }
        base
    };
    let x_label = evaluate_display_string(&x_label, &numeric, Some(&string_ctx));
    let y_label = evaluate_display_string(&y_label, &numeric, Some(&string_ctx));

    // xAxis/yAxis components can each be a braced expression too (e.g. the
    // high bound `{ cltHighXaxis }`, a ternary on the metric/imperial PC
    // variable) - a bound that fails to evaluate is dropped entirely rather
    // than guessed at, so the frontend falls back to the bins' own range
    // instead of silently clamping edits to a wrong number.
    let resolve_axis = |raw: &Option<(String, String, String)>| -> Option<(f32, f32, f32)> {
        let (min, max, step) = raw.as_ref()?;
        Some((
            evaluate_numeric_string(min, &numeric, Some(&string_ctx))?,
            evaluate_numeric_string(max, &numeric, Some(&string_ctx))?,
            evaluate_numeric_string(step, &numeric, Some(&string_ctx))?,
        ))
    };
    let x_axis = resolve_axis(&x_axis_raw);
    let y_axis = resolve_axis(&y_axis_raw);

    // A series with no {visibility expression} is always shown; one that
    // fails to evaluate fails open (visible) rather than silently hiding
    // data the user might need.
    let additional_y_series: Vec<CurveSeriesData> = additional_series_values
        .into_iter()
        .map(|(values, visibility_expr, label)| {
            let visible = visibility_expr
                .as_deref()
                .map(|expr| evaluate_numeric_string(expr, &numeric, Some(&string_ctx)).unwrap_or(1.0) != 0.0)
                .unwrap_or(true);
            CurveSeriesData {
                values,
                label,
                visible,
            }
        })
        .collect();

    Ok(CurveData {
        name: curve_name_out,
        title: curve_title,
        x_bins,
        y_bins,
        x_label,
        y_label,
        primary_y_line_label,
        additional_y_series,
        x_axis,
        y_axis,
        x_output_channel,
        x_bins_read_only,
        y_bins_read_only,
        gauge,
    })
}

/// Snapshot of the definition-derived facts `write_constant_array_values`
/// needs, taken before `state.definition`'s lock is dropped (see
/// `update_curve_data`). Bundled into one struct rather than passed as two
/// separate params to stay under clippy's too-many-arguments threshold.
struct WriteContext {
    endianness: libretune_core::ini::Endianness,
    default_page_bytes: usize,
}

fn write_constant_array_values(
    ctx: &WriteContext,
    constant: &libretune_core::ini::Constant,
    values: &[f64],
    cache: &mut libretune_core::tune::TuneCache,
    tune: &mut Option<libretune_core::tune::TuneFile>,
    tune_modified: &mut bool,
    conn: &mut Option<&mut Connection>,
) -> Result<(), String> {
    if values.len() != constant.shape.element_count() {
        return Err(format!(
            "Invalid data size for {}: expected {}, got {}",
            constant.name,
            constant.shape.element_count(),
            values.len()
        ));
    }

    let element_size = constant.data_type.size_bytes();
    let mut raw_data = vec![0u8; constant.size_bytes()];

    for (i, val) in values.iter().enumerate() {
        let raw_val = constant.display_to_raw(*val);
        let offset = i * element_size;
        constant
            .data_type
            .write_to_bytes(&mut raw_data, offset, raw_val, ctx.endianness);
    }

    if cache.write_bytes(constant.page, constant.offset, &raw_data) {
        if let Some(tune) = tune.as_mut() {
            tune.constants.insert(
                constant.name.clone(),
                libretune_core::tune::TuneValue::Array(values.to_vec()),
            );

            let page_data = tune
                .pages
                .entry(constant.page)
                .or_insert_with(|| vec![0u8; ctx.default_page_bytes]);

            let start = constant.offset as usize;
            let end = start + raw_data.len();
            if end <= page_data.len() {
                page_data[start..end].copy_from_slice(&raw_data);
            }
        }

        *tune_modified = true;
    }

    if let Some(conn) = conn.as_mut() {
        let params = libretune_core::protocol::commands::WriteMemoryParams {
            can_id: 0,
            page: constant.page,
            offset: constant.offset,
            data: raw_data,
        };

        if let Err(e) = conn.write_memory(params) {
            eprintln!(
                "[WARN] Failed to write constant '{}' to ECU: {}",
                constant.name, e
            );
        }
    }

    Ok(())
}

/// Updates curve X and/or Y bin values (including additional §9.2.1 series)
/// in the tune cache and optionally writes to ECU.
#[tauri::command]
pub async fn update_curve_data(
    state: tauri::State<'_, AppState>,
    curve_name: String,
    y_values: Option<Vec<f64>>,
    x_values: Option<Vec<f64>>,
    additional_y_values: Option<Vec<Vec<f64>>>,
) -> Result<(), String> {
    if y_values.is_none() && x_values.is_none() && additional_y_values.is_none() {
        return Err("No curve values provided".to_string());
    }

    // Snapshot only what we need from the definition, then drop the lock
    // before doing any ECU I/O below — holding it across a blocking
    // conn.write_memory() call starves every other command that needs the
    // definition (e.g. load_tune, table/curve reads). Matches the
    // established pattern in update_constant/update_constant_array_internal.
    let (x_ctx, x_const, x_bins_read_only, y_ctx, y_const, y_bins_read_only, additional_series) = {
        let def_guard = state.definition.lock().await;
        let def = def_guard.as_ref().ok_or("Definition not loaded")?;

        let curve = def
            .get_curve_by_name_or_map(&curve_name)
            .ok_or_else(|| format!("Curve {} not found", curve_name))?;
        let x_bins_read_only = curve.x_bins_read_only;
        let y_bins_read_only = curve.y_bins_read_only;

        let x_const_name = curve.x_bins.clone();
        let y_const_name = curve.y_bins.clone();
        let x_const = def
            .constants
            .get(&x_const_name)
            .ok_or_else(|| {
                format!(
                    "Constant {} not found for curve {}",
                    x_const_name, curve_name
                )
            })?
            .clone();
        let y_const = def
            .constants
            .get(&y_const_name)
            .ok_or_else(|| {
                format!(
                    "Constant {} not found for curve {}",
                    y_const_name, curve_name
                )
            })?
            .clone();

        let x_ctx = WriteContext {
            endianness: def.endianness,
            default_page_bytes: def
                .page_sizes
                .get(x_const.page as usize)
                .copied()
                .unwrap_or(256) as usize,
        };
        let y_ctx = WriteContext {
            endianness: def.endianness,
            default_page_bytes: def
                .page_sizes
                .get(y_const.page as usize)
                .copied()
                .unwrap_or(256) as usize,
        };

        // Same (constant, WriteContext) snapshot as x_const/y_const above,
        // one per §9.2.1 additional series, in curve.additional_y_series
        // order - the order additional_y_values must arrive in.
        let additional_series: Vec<(Constant, WriteContext)> = curve
            .additional_y_series
            .iter()
            .filter_map(|series| {
                let constant = def.constants.get(&series.bins)?;
                let ctx = WriteContext {
                    endianness: def.endianness,
                    default_page_bytes: def
                        .page_sizes
                        .get(constant.page as usize)
                        .copied()
                        .unwrap_or(256) as usize,
                };
                Some((constant.clone(), ctx))
            })
            .collect();

        (
            x_ctx,
            x_const,
            x_bins_read_only,
            y_ctx,
            y_const,
            y_bins_read_only,
            additional_series,
        )
    };

    let mut conn_guard = state.connection.lock().await;
    let mut cache_guard = state.tune_cache.lock().await;
    let mut tune_guard = state.current_tune.lock().await;
    let mut modified_guard = state.tune_modified.lock().await;

    let cache = cache_guard
        .as_mut()
        .ok_or("Tune cache not initialized — open or create a project first")?;
    let mut conn = conn_guard.as_mut();

    // The frontend always resends both axes together (even when only one
    // changed), so a readOnly axis's incoming values are silently dropped
    // here rather than rejecting the whole save - the other, editable axis
    // still needs to persist.
    if let Some(values) = x_values {
        if x_bins_read_only {
            eprintln!(
                "[WARN] update_curve_data: ignoring x_values for readOnly curve '{}'",
                curve_name
            );
        } else {
            write_constant_array_values(
                &x_ctx,
                &x_const,
                &values,
                cache,
                &mut tune_guard,
                &mut modified_guard,
                &mut conn,
            )?;
        }
    }

    if let Some(values) = y_values {
        if y_bins_read_only {
            eprintln!(
                "[WARN] update_curve_data: ignoring y_values for readOnly curve '{}'",
                curve_name
            );
        } else {
            write_constant_array_values(
                &y_ctx,
                &y_const,
                &values,
                cache,
                &mut tune_guard,
                &mut modified_guard,
                &mut conn,
            )?;
        }
    }

    // No readOnly concept exists for additional series - only x_bins/y_bins
    // carry that INI flag - so every one of these is always writable.
    if let Some(all_values) = additional_y_values {
        for (values, (constant, ctx)) in all_values.iter().zip(additional_series.iter()) {
            write_constant_array_values(
                ctx,
                constant,
                values,
                cache,
                &mut tune_guard,
                &mut modified_guard,
                &mut conn,
            )?;
        }
    }

    Ok(())
}
