/**
 * CurveEditor - Unified curve editing component
 * 
 * Renders and allows editing of 2D curves from INI CurveEditor definitions.
 * Supports both embedded mode (in dialogs) and standalone mode (as a tab).
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowLeft, Save, Flame, Undo2, Redo2, AlertTriangle, Lock } from 'lucide-react';
import { GaugeLiveReadout } from '../gauges/GaugeLiveReadout';
import { TsGaugeConfig } from '../dashboards/dashTypes';
import { valueToHeatmapColor, textColorForBackground } from '../../utils/heatmapColors';
import { useChannelValue } from '../../stores/realtimeStore';
import { clampXBinEdit } from './clampXBinEdit';
import './CurveEditor.css';

/** Simple gauge info from backend INI [GaugeConfigurations] */
export interface SimpleGaugeInfo {
  name: string;
  channel: string;
  title: string;
  units: string;
  lo: number;
  hi: number;
  low_warning: number;
  high_warning: number;
  low_danger: number;
  high_danger: number;
  digits: number;
}

/** Convert SimpleGaugeInfo to TsGaugeConfig for embedded dialog/curve gauges */
export function toTsGaugeConfig(gauge: SimpleGaugeInfo): TsGaugeConfig {
  return {
    id: gauge.name,
    gauge_painter: 'AnalogGauge',
    gauge_style: '',
    output_channel: gauge.channel,
    title: gauge.title,
    units: gauge.units,
    value: 0,
    min: gauge.lo,
    max: gauge.hi,
    min_vp: null,
    max_vp: null,
    default_min: null,
    default_max: null,
    peg_limits: false,
    low_warning: gauge.low_warning,
    high_warning: gauge.high_warning,
    low_critical: gauge.low_danger,
    high_critical: gauge.high_danger,
    low_warning_vp: null,
    high_warning_vp: null,
    low_critical_vp: null,
    high_critical_vp: null,
    back_color: { alpha: 255, red: 40, green: 40, blue: 40 },
    font_color: { alpha: 255, red: 255, green: 255, blue: 255 },
    trim_color: { alpha: 255, red: 192, green: 192, blue: 192 },
    warn_color: { alpha: 255, red: 255, green: 200, blue: 0 },
    critical_color: { alpha: 255, red: 255, green: 0, blue: 0 },
    needle_color: { alpha: 255, red: 255, green: 0, blue: 0 },
    value_digits: gauge.digits,
    label_digits: 0,
    font_family: 'sans-serif',
    font_size_adjustment: 0,
    italic_font: false,
    start_angle: 225,
    sweep_angle: 270,
    face_angle: 0,
    sweep_begin_degree: 0,
    counter_clockwise: false,
    major_ticks: 10,
    minor_ticks: 5,
    relative_x: 0,
    relative_y: 0,
    relative_width: 1,
    relative_height: 1,
    border_width: 0,
    shortest_size: 100,
    shape_locked_to_aspect: true,
    antialiasing_on: true,
    background_image_file_name: null,
    needle_image_file_name: null,
    peak_hold: false,
    history_value: 0,
    history_delay: 0,
    needle_smoothing: 0,
    short_click_action: null,
    long_click_action: null,
    display_value_at_180: false,
  };
}

/** Extended curve data from backend */
export interface CurveData {
  name: string;
  title: string;
  x_bins: number[];
  y_bins: number[];
  x_label: string;
  y_label: string;
  x_axis?: [number, number, number] | null; // [min, max, step]
  y_axis?: [number, number, number] | null;
  x_output_channel?: string | null;
  /** INI's `xBins = ..., readOnly` - this axis tracks a fixed reference and must not be edited here. */
  x_bins_read_only?: boolean;
  /** See `x_bins_read_only`. */
  y_bins_read_only?: boolean;
  gauge?: string | null;
  /** `lineLabel` matched to the primary `y_bins` series when the curve has more than one (§9.2.1). */
  primary_y_line_label?: string | null;
  /** Extra series beyond the primary `y_bins` series - each its own editable table row and chart line, sharing x_bins. */
  additional_y_series?: CurveSeriesData[];
}

/** One extra Y-axis series on a multi-series curve (see `CurveData.additional_y_series`). */
export interface CurveSeriesData {
  values: number[];
  label?: string | null;
  visible: boolean;
}

/** Colors for `additional_y_series` lines, distinct from the primary series' yellow (#f5d742)
 * and the live-cursor's red (#ff4444). Cycles if a curve has more series than colors (rangeMatrix has 11). */
const ADDITIONAL_SERIES_COLORS = [
  '#4f8fe8', // blue
  '#3dba6f', // green
  '#c069d8', // purple
  '#e0a030', // orange
  '#2fc4c4', // teal
  '#e05252', // muted red (distinct enough from live-cursor red at 0.85 opacity)
  '#d8d8d8', // light gray
  '#7f7ff0', // indigo
];

/** Values edited in a curve table (X = coolant/temperature bins, Y = PWM/output). */
export interface CurveBinValues {
  xBins: number[];
  yBins: number[];
  /** One array per §9.2.1 additional series, in `data.additional_y_series` order. */
  additionalSeries?: number[][];
}

interface CurveEditorProps {
  /** Curve data from backend */
  data: CurveData;
  /** Whether this is embedded in a dialog (compact mode) */
  embedded?: boolean;
  /** Full TsGaugeConfig for embedded display (optional) */
  gaugeConfig?: TsGaugeConfig | null;
  /** Simple gauge info from INI (alternative to gaugeConfig) */
  simpleGaugeInfo?: SimpleGaugeInfo | null;
  /** Callback when X or Y bin values are modified */
  onValuesChange?: (values: CurveBinValues) => void;
  /** Callback when user wants to go back (standalone mode) */
  onBack?: () => void;
  /** Menu label for display in title */
  menuLabel?: string;
}

export default function CurveEditor({
  data: rawData,
  embedded = false,
  gaugeConfig,
  simpleGaugeInfo,
  onValuesChange,
  onBack,
  menuLabel,
}: CurveEditorProps) {
  // Normalize data in case curve data is provided in table-shaped format (xAxis/zValues)
  let data = rawData as CurveData & {
    xAxis?: number[];
    yAxis?: number[];
    zValues?: number[][];
    xLabel?: string;
    yLabel?: string;
  };
  if (data && (!Array.isArray(data.x_bins) || data.x_bins.length === 0) && Array.isArray(data.xAxis)) {
    const normalizedYBins = Array.isArray(data.y_bins)
      ? data.y_bins
      : (Array.isArray(data.zValues) ? (data.zValues[0] ?? []) : []);
    data = {
      ...data,
      x_bins: data.xAxis,
      y_bins: normalizedYBins,
      x_label: data.x_label || data.xLabel || '',
      y_label: data.y_label || data.yLabel || '',
    };
  }
  // Determine if data is valid - used for conditional rendering after hooks
  const hasValidData = 
    data &&
    data.x_bins && Array.isArray(data.x_bins) && data.x_bins.length > 0 &&
    data.y_bins && Array.isArray(data.y_bins) && data.y_bins.length > 0;

  // Use safe fallback values for hooks when data is invalid
  const safeYBins = hasValidData ? data.y_bins : [0];
  const safeXBinsArray = hasValidData ? data.x_bins : [0];
  const safeXOutputChannel = hasValidData && data.x_output_channel ? data.x_output_channel : '';

  // Get realtime value for the X output channel from Zustand store
  const xOutputChannelValue = useChannelValue(safeXOutputChannel, undefined);
  
  // Local copies for editing
  const [localXBins, setLocalXBins] = useState<number[]>([...safeXBinsArray]);
  const [localYBins, setLocalYBins] = useState<number[]>([...safeYBins]);
  // One array per §9.2.1 additional series (data.additional_y_series order) - each its own editable table row.
  const [localAdditionalSeries, setLocalAdditionalSeries] = useState<number[][]>(
    (hasValidData ? data.additional_y_series : undefined)?.map((s) => [...s.values]) ?? [],
  );
  // Selected point index - drives the chart's point marker/drag and the
  // container-level keyboard nudge, both of which only ever act on the
  // primary series regardless of which table row was clicked.
  const [selectedPoint, setSelectedPoint] = useState<number | null>(null);
  // Table cell range selection - a rectangle from selectionAnchor to
  // selectionEnd (inclusive) over (bin index, row) space, built by dragging
  // across cells like a spreadsheet. A plain click (mousedown+mouseup with
  // no drag in between) leaves anchor === end, a 1-cell "range" - see
  // selectedRangeCells below, which both the single-cell click path and the
  // multi-cell bulk-edit path read from, so there's one code path for both.
  const [selectionAnchor, setSelectionAnchor] = useState<{ index: number; axis: 'x' | 'y' | number } | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<{ index: number; axis: 'x' | 'y' | number } | null>(null);
  const [isRangeDragging, setIsRangeDragging] = useState(false);
  // Dragging state
  const [isDragging, setIsDragging] = useState(false);
  const [dragPointIndex, setDragPointIndex] = useState<number | null>(null);
  // Table input value for editing. axis is 'x'/'y' for the shared/primary
  // rows, or a number indexing data.additional_y_series for an extra row.
  const [editingCell, setEditingCell] = useState<{ index: number; axis: 'x' | 'y' | number } | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  // Undo/Redo history
  const [history, setHistory] = useState<CurveBinValues[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  // Axis override state (for manual scaling)
  const [yAxisOverride, setYAxisOverride] = useState<{ min?: number; max?: number; auto: boolean }>({ auto: true });
  const [xAxisOverride, setXAxisOverride] = useState<{ min?: number; max?: number; auto: boolean }>({ auto: true });
  // SVG container ref
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  // Embedded mode's chart box is CSS-sized (width: 100%, capped 320-500px —
  // see CurveEditor.css), not fixed — this tracks the box's actual rendered
  // width so the SVG/axes can match it instead of assuming 500px.
  const [measuredChartWidth, setMeasuredChartWidth] = useState<number | null>(null);

  useEffect(() => {
    if (!embedded) return;
    const el = chartContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setMeasuredChartWidth(width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [embedded]);

  // Update local values when data changes
  useEffect(() => {
    if (hasValidData) {
      setLocalXBins([...data.x_bins]);
      setLocalYBins([...data.y_bins]);
      setLocalAdditionalSeries((data.additional_y_series ?? []).map((s) => [...s.values]));
    }
  }, [hasValidData, data?.x_bins, data?.y_bins, data?.additional_y_series]);

  // Click-outside handler for context menu
  useEffect(() => {
    if (!contextMenu) return;
    
    const handleClickOutside = () => closeContextMenu();
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextMenu();
    };
    
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    
    return () => {
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [contextMenu]);

  // Helper to compute cell background color based on value position in range
  // Uses centralized heatmap color utility for consistent styling
  const getCellColor = useCallback((value: number, min: number, max: number): string => {
    return valueToHeatmapColor(value, min, max, 'tunerstudio');
  }, []);

  const getHeatmapCellStyle = useCallback((value: number, min: number, max: number): React.CSSProperties => {
    const backgroundColor = getCellColor(value, min, max);
    return {
      backgroundColor,
      color: textColorForBackground(backgroundColor),
    };
  }, [getCellColor]);

  // Chart dimensions based on mode. Embedded width comes from the actual
  // rendered chart box (see the ResizeObserver above) — CSS decides the
  // available space (100%, capped 320-500px), this just matches it; 500 is
  // only a placeholder for the first render before the box is measured.
  const chartWidth = embedded ? Math.round(measuredChartWidth ?? 500) : 500;
  const chartHeight = embedded ? 280 : 350;
  const padding = { top: 30, right: 20, bottom: 40, left: 50 };

  const getNiceStep = useCallback((min: number, max: number, targetTicks: number = 5) => {
    const range = Math.abs(max - min);
    if (!isFinite(range) || range === 0) return 1;
    const rough = range / Math.max(1, targetTicks);
    const pow10 = Math.pow(10, Math.floor(Math.log10(rough)));
    const frac = rough / pow10;
    let niceFrac = 1;
    if (frac >= 5) {
      niceFrac = 5;
    } else if (frac >= 2) {
      niceFrac = 2;
    }
    return niceFrac * pow10;
  }, []);

  // Calculate axis bounds (respecting overrides)
  const xAxis = useMemo(() => {
    // Guard against invalid data - use safe defaults
    if (!hasValidData || !data.x_bins || data.x_bins.length === 0) {
      return { min: 0, max: 100, step: 10 };
    }
    
    const base = data.x_axis 
      ? { min: data.x_axis[0], max: data.x_axis[1], step: data.x_axis[2] }
      : (() => {
          const min = Math.min(...data.x_bins);
          const max = Math.max(...data.x_bins);
          return { min, max, step: getNiceStep(min, max) };
        })();
    
    if (!xAxisOverride.auto) {
      return {
        min: xAxisOverride.min ?? base.min,
        max: xAxisOverride.max ?? base.max,
        step: base.step
      };
    }
    return base;
  }, [hasValidData, data?.x_axis, data?.x_bins, xAxisOverride]);

  const yAxis = useMemo(() => {
    // Guard against invalid data - use safe defaults
    if (!hasValidData || !localYBins || localYBins.length === 0) {
      return { min: 0, max: 100, step: 10 };
    }
    
    const yMin = Math.min(...localYBins);
    const yMax = Math.max(...localYBins);
    const dataPadding = (yMax - yMin) * 0.1 || 0.5;
    
    const base = data.y_axis 
      ? { min: data.y_axis[0], max: data.y_axis[1], step: data.y_axis[2] }
      : (() => {
          const min = yMin - dataPadding;
          const max = yMax + dataPadding;
          return { min, max, step: getNiceStep(min, max) };
        })();
    
    if (!yAxisOverride.auto) {
      return {
        min: yAxisOverride.min ?? base.min,
        max: yAxisOverride.max ?? base.max,
        step: base.step
      };
    }
    return base;
  }, [hasValidData, data?.y_axis, localYBins, yAxisOverride]);

  // Scale functions
  const scaleX = useCallback((x: number) => {
    const range = xAxis.max - xAxis.min || 1;
    return padding.left + ((x - xAxis.min) / range) * (chartWidth - padding.left - padding.right);
  }, [xAxis, chartWidth, padding]);

  const scaleY = useCallback((y: number) => {
    const range = yAxis.max - yAxis.min || 1;
    return chartHeight - padding.bottom - ((y - yAxis.min) / range) * (chartHeight - padding.top - padding.bottom);
  }, [yAxis, chartHeight, padding]);

  const unscaleY = useCallback((screenY: number) => {
    const range = yAxis.max - yAxis.min || 1;
    const normalized = (chartHeight - padding.bottom - screenY) / (chartHeight - padding.top - padding.bottom);
    return yAxis.min + normalized * range;
  }, [yAxis, chartHeight, padding]);

  // Generate grid lines with limited labels for readability
  const gridLines = useMemo(() => {
    const lines: { x1: number; y1: number; x2: number; y2: number; label?: string; isAxis?: boolean }[] = [];
    
    // X-axis: INI step value is the number of divisions, not the step size
    // Limit to ~7 labels max for readability
    const xRange = xAxis.max - xAxis.min;
    const xDivisions = Math.min(xAxis.step || 10, 10); // step is actually division count
    const xStep = xRange / xDivisions;
    
    // Calculate a nice round step value
    const xNiceStep = Math.ceil(xStep / 10) * 10 || xStep; // Round to nearest 10
    const xLabelStep = xRange / Math.min(7, Math.ceil(xRange / xNiceStep));
    
    for (let x = xAxis.min; x <= xAxis.max + 0.001; x += xLabelStep) {
      const roundedX = Math.round(x);
      lines.push({
        x1: scaleX(roundedX), y1: padding.top,
        x2: scaleX(roundedX), y2: chartHeight - padding.bottom,
        label: roundedX.toFixed(0),
        isAxis: roundedX === xAxis.min
      });
    }
    
    // Y-axis: Similar treatment - step is division count
    const yRange = yAxis.max - yAxis.min;
    const yDivisions = Math.min(yAxis.step || 10, 10);
    const yLabelStep = yRange / yDivisions;
    
    for (let y = yAxis.min; y <= yAxis.max + 0.001; y += yLabelStep) {
      lines.push({
        x1: padding.left, y1: scaleY(y),
        x2: chartWidth - padding.right, y2: scaleY(y),
        label: y.toFixed(2),
        isAxis: Math.abs(y - yAxis.min) < 0.001
      });
    }
    
    return lines;
  }, [xAxis, yAxis, scaleX, scaleY, chartWidth, chartHeight, padding]);

  // Polyline points
  const polylinePoints = useMemo(() => {
    if (!hasValidData || localXBins.length === 0) return '';
    return localXBins.map((x, i) => `${scaleX(x)},${scaleY(localYBins[i] ?? 0)}`).join(' ');
  }, [hasValidData, localXBins, localYBins, scaleX, scaleY]);

  // Live cursor position
  const liveCursor = useMemo(() => {
    if (!hasValidData || localXBins.length === 0) return null;
    if (xOutputChannelValue === undefined || !data.x_output_channel) return null;
    const xValue = xOutputChannelValue;
    
    // Find the interpolated Y value (supports ascending or descending bins)
    let yValue = localYBins[0] ?? 0;
    const ascending = localXBins[0] <= localXBins[localXBins.length - 1];
    for (let i = 0; i < localXBins.length - 1; i++) {
      const start = localXBins[i];
      const end = localXBins[i + 1];
      const inRange = ascending
        ? xValue >= start && xValue <= end
        : xValue <= start && xValue >= end;
      if (inRange) {
        const denom = end - start;
        const t = denom !== 0 ? (xValue - start) / denom : 0;
        yValue = (localYBins[i] ?? 0) + t * ((localYBins[i + 1] ?? 0) - (localYBins[i] ?? 0));
        break;
      }
    }
    if ((ascending && xValue > localXBins[localXBins.length - 1]) || (!ascending && xValue < localXBins[localXBins.length - 1])) {
      yValue = localYBins[localYBins.length - 1] ?? 0;
    }
    
    return { x: xValue, y: yValue, screenX: scaleX(xValue), screenY: scaleY(yValue) };
  }, [hasValidData, xOutputChannelValue, data?.x_output_channel, localXBins, localYBins, scaleX, scaleY]);

  // Persist changes to backend
  const persistCurveValues = useCallback(async (xBins: number[], yBins: number[], additionalSeries: number[][] = localAdditionalSeries) => {
    try {
      await invoke('update_curve_data', {
        curveName: data.name,
        xValues: xBins,
        yValues: yBins,
        additionalYValues: additionalSeries,
      });
      onValuesChange?.({ xBins, yBins, additionalSeries });
    } catch (err) {
      console.error('Failed to update curve:', err);
    }
  }, [data.name, onValuesChange, localAdditionalSeries]);

  const currentSnapshot = useCallback(
    (): CurveBinValues => ({
      xBins: [...localXBins],
      yBins: [...localYBins],
      additionalSeries: localAdditionalSeries.map((s) => [...s]),
    }),
    [localXBins, localYBins, localAdditionalSeries],
  );

  // Push current state to history before making changes
  const pushHistory = useCallback(() => {
    const snapshot = currentSnapshot();
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(snapshot);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  }, [currentSnapshot, history, historyIndex]);

  // Undo last change
  const undo = useCallback(() => {
    if (historyIndex >= 0) {
      const previousState = history[historyIndex];
      const additionalSeries = previousState.additionalSeries ?? [];
      setLocalXBins(previousState.xBins);
      setLocalYBins(previousState.yBins);
      setLocalAdditionalSeries(additionalSeries);
      setHistoryIndex(historyIndex - 1);
      persistCurveValues(previousState.xBins, previousState.yBins, additionalSeries);
    }
  }, [history, historyIndex, persistCurveValues]);

  // Redo last undone change
  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const nextState = history[historyIndex + 1];
      const additionalSeries = nextState.additionalSeries ?? [];
      setHistoryIndex(historyIndex + 1);
      setLocalXBins(nextState.xBins);
      setLocalYBins(nextState.yBins);
      setLocalAdditionalSeries(additionalSeries);
      persistCurveValues(nextState.xBins, nextState.yBins, additionalSeries);
    }
  }, [history, historyIndex, persistCurveValues]);

  // Nudge the selected point's Y value with the keyboard (Up/Down; Shift for
  // a bigger step) - the chart only lets you drag Y, so that is what arrow
  // keys move too. Step is relative to the axis range since curves cover
  // wildly different scales (a 0-100% bias vs. a +/-10 degree trim).
  const nudgeSelectedPoint = useCallback(
    (direction: 1 | -1, big: boolean) => {
      if (selectedPoint === null || data.y_bins_read_only) return;
      const range = yAxis.max - yAxis.min;
      const step = big ? Math.max(range * 0.05, 1) : Math.max(range * 0.01, 0.1);
      const current = localYBins[selectedPoint] ?? 0;
      const clamped = Math.max(yAxis.min, Math.min(yAxis.max, current + step * direction));
      const next = [...localYBins];
      next[selectedPoint] = clamped;
      pushHistory();
      setLocalYBins(next);
      persistCurveValues(localXBins, next);
    },
    [selectedPoint, yAxis, localYBins, localXBins, pushHistory, persistCurveValues, data.y_bins_read_only],
  );

  // Left/Right moves the selection to the previous/next bin, so once you've
  // arrowed a point's value into place you can keep going down the curve
  // without reaching for the mouse.
  const moveSelectionBy = useCallback(
    (delta: 1 | -1) => {
      if (selectedPoint === null || localXBins.length === 0) return;
      const next = Math.max(0, Math.min(localXBins.length - 1, selectedPoint + delta));
      setSelectedPoint(next);
    },
    [selectedPoint, localXBins.length],
  );

  // Keyboard shortcuts: undo/redo, Up/Down to nudge the selected point's
  // value, Left/Right to move the selection (disabled while a table cell is
  // mid-edit, where arrows should be free for normal text-input behavior).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (!editingCell && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        nudgeSelectedPoint(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
      } else if (!editingCell && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        moveSelectionBy(e.key === 'ArrowRight' ? 1 : -1);
      }
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener('keydown', handleKeyDown);
      return () => container.removeEventListener('keydown', handleKeyDown);
    }
  }, [undo, redo, editingCell, nudgeSelectedPoint, moveSelectionBy]);

  // Handle mouse down on a point - push history first
  const handlePointMouseDown = (e: React.MouseEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedPoint(index);
    // preventDefault above blocks the browser's usual click-to-focus, but
    // the arrow-key nudge below needs this container focused to receive
    // the keydown at all - without this, selecting a point and pressing
    // an arrow key does nothing.
    containerRef.current?.focus();
    // Dragging only ever moves Y (see updateDragFromClientY) - a curve
    // whose INI marks yBins readOnly stays selectable/navigable, just not
    // draggable.
    if (data.y_bins_read_only) return;
    pushHistory(); // Save state before editing
    setIsDragging(true);
    setDragPointIndex(index);
  };

  /** Move the currently dragged point to the given clientY (shared by point-grab, chart-grab, and window listeners). */
  const updateDragFromClientY = useCallback((clientY: number, pointIndex: number | null = dragPointIndex) => {
    if (pointIndex === null || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const screenY = clientY - rect.top;
    let newY = unscaleY(screenY);
    // Clamp to axis bounds
    newY = Math.max(yAxis.min, Math.min(yAxis.max, newY));
    setLocalYBins(prev => {
      const next = [...prev];
      next[pointIndex] = newY;
      return next;
    });
  }, [dragPointIndex, unscaleY, yAxis]);

  // Click anywhere in the plot area to grab the nearest point and drag it
  // (TS-style curve editing — no need to hit the small point circles).
  const handleChartMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || !svgRef.current || !hasValidData || localXBins.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    // Only react to clicks inside the plot area
    if (
      sx < padding.left || sx > chartWidth - padding.right ||
      sy < padding.top || sy > chartHeight - padding.bottom
    ) {
      return;
    }
    // Find the nearest bin by screen X distance
    let nearest = 0;
    let bestDist = Infinity;
    localXBins.forEach((x, i) => {
      const d = Math.abs(scaleX(x) - sx);
      if (d < bestDist) {
        bestDist = d;
        nearest = i;
      }
    });
    e.preventDefault();
    setSelectedPoint(nearest);
    containerRef.current?.focus();
    if (data.y_bins_read_only) return;
    pushHistory();
    setIsDragging(true);
    setDragPointIndex(nearest);
    // Immediately snap the grabbed point to the clicked Y
    updateDragFromClientY(e.clientY, nearest);
  };

  // Handle mouse up to end dragging
  const handleMouseUp = useCallback(() => {
    if (isDragging && dragPointIndex !== null) {
      persistCurveValues(localXBins, localYBins);
    }
    setIsDragging(false);
    setDragPointIndex(null);
  }, [isDragging, dragPointIndex, localXBins, localYBins, persistCurveValues]);

  // While dragging, track the mouse at window level so the drag continues
  // smoothly outside the SVG and always commits on release.
  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => updateDragFromClientY(e.clientY);
    const onUp = () => handleMouseUp();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isDragging, updateDragFromClientY, handleMouseUp]);

  // A cell's current value, for any row: 'x' (shared bins), 'y' (primary
  // series), or a number indexing an additional §9.2.1 series row.
  const cellValue = useCallback(
    (index: number, axis: 'x' | 'y' | number): number => {
      if (axis === 'x') return localXBins[index] ?? 0;
      if (axis === 'y') return localYBins[index] ?? 0;
      return localAdditionalSeries[axis]?.[index] ?? 0;
    },
    [localXBins, localYBins, localAdditionalSeries],
  );

  // Table row order top-to-bottom, for Up/Down cell navigation: primary Y,
  // then each visible additional series, then the shared X row - matches
  // renderCurveTableBody's actual rendering order below.
  const rowOrder = useMemo<Array<'x' | 'y' | number>>(() => {
    const seriesRows = (data.additional_y_series ?? [])
      .map((s, i) => (s.visible ? i : null))
      .filter((i): i is number => i !== null);
    return ['y', ...seriesRows, 'x'];
  }, [data.additional_y_series]);

  // Rectangular selection over (bin index, row) space, built by dragging.
  // anchor === end for a plain click - a 1-cell "range". A row's readOnly
  // cells stay part of the visual selection (matches clicking one alone,
  // which still selects it for viewing) but are skipped when a bulk edit
  // actually commits, below.
  const selectedRangeCells = useMemo(() => {
    if (!selectionAnchor || !selectionEnd) return [];
    const rowLo = Math.min(rowOrder.indexOf(selectionAnchor.axis), rowOrder.indexOf(selectionEnd.axis));
    const rowHi = Math.max(rowOrder.indexOf(selectionAnchor.axis), rowOrder.indexOf(selectionEnd.axis));
    const colLo = Math.min(selectionAnchor.index, selectionEnd.index);
    const colHi = Math.max(selectionAnchor.index, selectionEnd.index);
    const cells: Array<{ index: number; axis: 'x' | 'y' | number }> = [];
    for (let r = rowLo; r <= rowHi; r++) {
      for (let c = colLo; c <= colHi; c++) {
        cells.push({ index: c, axis: rowOrder[r] });
      }
    }
    return cells;
  }, [selectionAnchor, selectionEnd, rowOrder]);

  const isRowReadOnly = useCallback(
    (axis: 'x' | 'y' | number) =>
      axis === 'x' ? !!data.x_bins_read_only : axis === 'y' ? !!data.y_bins_read_only : false,
    [data.x_bins_read_only, data.y_bins_read_only],
  );

  const commitCellEdit = useCallback(
    (index: number, axis: 'x' | 'y' | number) => {
      const parsed = parseFloat(editValue);
      if (isNaN(parsed)) {
        setEditingCell(null);
        return;
      }

      // More than one cell selected (a drag, not a plain click) - Enter
      // applies the typed value to every selected cell, not just the one
      // showing the input (see handleMouseUpGlobal, which only opens the
      // input on the anchor cell of a multi-cell drag).
      const targets = selectedRangeCells.length > 1 ? selectedRangeCells : [{ index, axis }];

      // A single click opens edit mode immediately (see handleCellClick),
      // so a click-then-click-elsewhere with no typing in between reaches
      // here too via onBlur (and now also an ArrowLeft/Right/Up/Down that
      // navigates away without editing). editValue was seeded from the real
      // value rounded to a whole number for display; if the parsed result
      // still matches that rounding, nothing was actually typed - skip the
      // write so browsing/navigating can't quietly truncate a value's real
      // precision (e.g. 18.4373 -> 18) or spam the undo history with no-op
      // entries. Only applies to a single targeted cell - a bulk edit
      // always applies, even if the anchor cell's own value looks
      // unchanged, since the other selected cells may still need it.
      if (targets.length === 1) {
        const original = cellValue(index, axis);
        if (parsed === Number(original.toFixed(0))) {
          setEditingCell(null);
          return;
        }
      }

      pushHistory();

      let newXBins = localXBins;
      let newYBins = localYBins;
      let newSeries = localAdditionalSeries;
      let xChanged = false;
      let yChanged = false;
      let seriesChanged = false;

      for (const t of targets) {
        if (isRowReadOnly(t.axis)) continue;
        if (t.axis === 'x') {
          if (!xChanged) {
            newXBins = [...localXBins];
            xChanged = true;
          }
          newXBins[t.index] = clampXBinEdit(newXBins, t.index, parsed, xAxis.min, xAxis.max);
        } else if (t.axis === 'y') {
          if (!yChanged) {
            newYBins = [...localYBins];
            yChanged = true;
          }
          newYBins[t.index] = Math.max(yAxis.min, Math.min(yAxis.max, parsed));
        } else {
          // Additional series share the curve's single Y axis (TunerStudio
          // plots them all on the same %/value scale).
          if (!seriesChanged) {
            newSeries = localAdditionalSeries.map((s) => [...s]);
            seriesChanged = true;
          }
          newSeries[t.axis][t.index] = Math.max(yAxis.min, Math.min(yAxis.max, parsed));
        }
      }

      if (xChanged) setLocalXBins(newXBins);
      if (yChanged) setLocalYBins(newYBins);
      if (seriesChanged) setLocalAdditionalSeries(newSeries);
      if (xChanged || yChanged || seriesChanged) {
        persistCurveValues(newXBins, newYBins, newSeries);
      }
      setEditingCell(null);
      if (targets.length > 1) {
        setSelectionAnchor(null);
        setSelectionEnd(null);
      }
    },
    [
      editValue,
      xAxis,
      yAxis,
      localXBins,
      localYBins,
      localAdditionalSeries,
      cellValue,
      selectedRangeCells,
      isRowReadOnly,
      pushHistory,
      persistCurveValues,
    ],
  );

  // A plain click both selects the point (for the chart/keyboard nav, same
  // as before) and - unless the axis is readOnly - opens that cell for
  // editing immediately. TunerStudio's own bin table doesn't need a
  // double-click first; requiring one here was just friction, and the value
  // shown while editing matches the whole-number display format (no
  // decimals - TunerStudio's own strip doesn't show any either). Also used
  // by arrow-key navigation and to open the anchor cell after a multi-cell
  // drag selection - both just want "select and edit exactly this cell".
  const handleCellClick = (index: number, axis: 'x' | 'y' | number) => {
    setSelectedPoint(index);
    setSelectionAnchor({ index, axis });
    setSelectionEnd({ index, axis });
    containerRef.current?.focus();

    if (isRowReadOnly(axis)) return;
    setEditingCell({ index, axis });
    setEditValue(cellValue(index, axis).toFixed(0));
  };

  // Drag-select across cells (own row or spanning rows) like a spreadsheet -
  // mousedown starts a new 1-cell selection, mouseenter while dragging
  // extends it to a rectangle (see selectedRangeCells), and the global
  // mouseup below decides what the gesture meant: no movement is a plain
  // click (select + edit that one cell, existing behavior); real movement
  // opens the anchor cell for editing but leaves the whole range selected,
  // so committing (Enter) fills every selected cell with the typed value.
  const handleCellMouseDown = (index: number, axis: 'x' | 'y' | number) => {
    setIsRangeDragging(true);
    setSelectionAnchor({ index, axis });
    setSelectionEnd({ index, axis });
  };

  const handleCellMouseEnter = (index: number, axis: 'x' | 'y' | number) => {
    if (!isRangeDragging) return;
    setSelectionEnd({ index, axis });
  };

  // Ends a table drag-selection wherever the mouse is released, even
  // outside the table (window-level, matching the chart-point drag effect
  // above). No movement between mousedown and mouseup is a plain click.
  useEffect(() => {
    if (!isRangeDragging) return;
    const onMouseUp = () => {
      setIsRangeDragging(false);
      if (!selectionAnchor || !selectionEnd) return;
      const isSingleCell =
        selectionAnchor.index === selectionEnd.index && selectionAnchor.axis === selectionEnd.axis;
      if (isSingleCell) {
        handleCellClick(selectionAnchor.index, selectionAnchor.axis);
        return;
      }
      containerRef.current?.focus();
      if (!isRowReadOnly(selectionAnchor.axis)) {
        setEditingCell({ index: selectionAnchor.index, axis: selectionAnchor.axis });
        setEditValue(cellValue(selectionAnchor.index, selectionAnchor.axis).toFixed(0));
      }
    };
    window.addEventListener('mouseup', onMouseUp);
    return () => window.removeEventListener('mouseup', onMouseUp);
  }, [isRangeDragging, selectionAnchor, selectionEnd, cellValue, isRowReadOnly]);

  // Arrow keys move to the neighboring cell instead of the browser's default
  // text-cursor movement - Left/Right across bins in the same row, Up/Down
  // to the same bin in the row above/below (rowOrder). Committing first
  // means a value typed before arrowing away is saved, same as Enter/blur.
  const handleCellKeyDown = (e: React.KeyboardEvent, index: number, axis: 'x' | 'y' | number) => {
    if (e.key === 'Enter') {
      commitCellEdit(index, axis);
    } else if (e.key === 'Escape') {
      setEditingCell(null);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      commitCellEdit(index, axis);
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      const nextIndex = Math.max(0, Math.min(localXBins.length - 1, index + delta));
      handleCellClick(nextIndex, axis);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      commitCellEdit(index, axis);
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const currentRow = rowOrder.indexOf(axis);
      const nextRow = rowOrder[Math.max(0, Math.min(rowOrder.length - 1, currentRow + delta))];
      handleCellClick(index, nextRow);
    }
  };

  const handleCellBlur = (index: number, axis: 'x' | 'y' | number) => {
    commitCellEdit(index, axis);
  };

  // Context menu handlers
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const closeContextMenu = () => {
    setContextMenu(null);
  };

  const setYAxisMin = () => {
    const value = prompt('Set Y Axis Minimum:', yAxis.min.toString());
    if (value !== null) {
      const num = parseFloat(value);
      if (!isNaN(num)) {
        setYAxisOverride(prev => ({ ...prev, min: num, auto: false }));
      }
    }
    closeContextMenu();
  };

  const setYAxisMax = () => {
    const value = prompt('Set Y Axis Maximum:', yAxis.max.toString());
    if (value !== null) {
      const num = parseFloat(value);
      if (!isNaN(num)) {
        setYAxisOverride(prev => ({ ...prev, max: num, auto: false }));
      }
    }
    closeContextMenu();
  };

  const setXAxisMin = () => {
    const value = prompt('Set X Axis Minimum:', xAxis.min.toString());
    if (value !== null) {
      const num = parseFloat(value);
      if (!isNaN(num)) {
        setXAxisOverride(prev => ({ ...prev, min: num, auto: false }));
      }
    }
    closeContextMenu();
  };

  const setXAxisMax = () => {
    const value = prompt('Set X Axis Maximum:', xAxis.max.toString());
    if (value !== null) {
      const num = parseFloat(value);
      if (!isNaN(num)) {
        setXAxisOverride(prev => ({ ...prev, max: num, auto: false }));
      }
    }
    closeContextMenu();
  };

  const toggleYAxisAuto = () => {
    setYAxisOverride(prev => ({ ...prev, auto: !prev.auto }));
    closeContextMenu();
  };

  const toggleXAxisAuto = () => {
    setXAxisOverride(prev => ({ ...prev, auto: !prev.auto }));
    closeContextMenu();
  };

  // Render error state if data is invalid (after all hooks have been called)
  if (!hasValidData) {
    const getErrorMessage = () => {
      if (!data) {
        return {
          summary: 'No curve data available.',
          details: 'The curve data object is null or undefined. This may indicate a backend loading error.',
          suggestion: 'Check the browser console for curve loading errors from get_curve_data.',
        };
      }
      if (!data.x_bins || !Array.isArray(data.x_bins) || data.x_bins.length === 0) {
        const xAxisConstant = data.name.replace(/Curve$/, 'Bins').replace(/Table$/, 'Bins');
        return {
          summary: `No X-axis bins available for curve "${data.title || data.name}".`,
          details: `Curve "${data.name}" has x_bins: ${JSON.stringify(data.x_bins)}`,
          suggestion: `The X-axis constant (possibly "${xAxisConstant}") may not be loaded from the tune file. Check if a string constant before it is disrupting offset calculation.`,
        };
      }
      if (!data.y_bins || !Array.isArray(data.y_bins) || data.y_bins.length === 0) {
        return {
          summary: `No Y-axis bins available for curve "${data.title || data.name}".`,
          details: `Curve "${data.name}" has y_bins: ${JSON.stringify(data.y_bins)}`,
          suggestion: 'The Y-axis constant may not be loaded from the tune file or may have zero elements.',
        };
      }
      return {
        summary: 'Unknown curve data error.',
        details: `Curve name: "${data.name}", x_bins: ${data.x_bins?.length ?? 0}, y_bins: ${data.y_bins?.length ?? 0}`,
        suggestion: 'Check browser console for more details.',
      };
    };

    const errorInfo = getErrorMessage();

    return (
      <div className="curve-editor curve-error-state" style={{ padding: '20px', textAlign: 'center' }}>
        <h3 style={{ color: 'var(--error)', marginBottom: '8px', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <AlertTriangle size={20} aria-hidden /> Curve Data Error
        </h3>
        <p style={{ color: 'var(--text-muted)', marginBottom: '12px' }}>{errorInfo.summary}</p>
        <details style={{ textAlign: 'left', background: 'rgba(0,0,0,0.2)', padding: '12px', borderRadius: '6px', marginBottom: '12px' }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>Diagnostic Details</summary>
          <pre style={{ fontSize: '11px', marginTop: '8px', whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>
{errorInfo.details}

Suggestion: {errorInfo.suggestion}
          </pre>
        </details>
        {onBack && (
          <button onClick={onBack} style={{ marginTop: '8px', display: 'inline-flex', alignItems: 'center', gap: 6 }} className="btn btn-secondary">
            <ArrowLeft size={14} /> Go Back
          </button>
        )}
      </div>
    );
  }

  // Display title
  const displayTitle = menuLabel 
    ? `${menuLabel} (${data.name})` 
    : data.title || data.name;

  // Gauge value from store
  const gaugeValue = xOutputChannelValue ?? 0;

  console.log(`[CurveEditor] Rendering curve '${data.name}' in ${embedded ? 'embedded' : 'standalone'} mode with ${localXBins.length} points`);

  // TunerStudio lays this out as one row per Y series plus one shared row
  // for the X bins at the bottom, one column per bin - matching its own
  // multi-series curve dialogs (e.g. "Line Pressure Per Gear Steady State"),
  // rather than a tall N-row/2-column list of numbers beside the chart.
  const renderCurveTableAxisRow = (
    axis: 'x' | 'y' | number,
    label: string,
    values: (number | undefined)[],
    range: { min: number; max: number },
    readOnly: boolean,
    color?: string,
  ) => (
    <tr key={axis} className={readOnly ? 'read-only' : ''}>
      <th
        className="curve-table-row-label"
        title={readOnly ? 'Locked by the INI - tracks a fixed reference axis' : undefined}
        style={color ? { color } : undefined}
      >
        {label}
        {readOnly && <Lock size={10} aria-label="Read-only" />}
      </th>
      {values.map((v, i) => {
        const value = v ?? 0;
        const cellStyle = getHeatmapCellStyle(value, range.min, range.max);
        const editing = editingCell?.index === i && editingCell.axis === axis;
        const cellClassName = axis === 'x' ? 'x-cell' : 'y-cell';

        const inSelection = selectedRangeCells.some((c) => c.index === i && c.axis === axis);

        return (
          <td
            key={i}
            className={`${cellClassName}${inSelection ? ' selected' : ''}`}
            style={cellStyle}
            onMouseDown={() => handleCellMouseDown(i, axis)}
            onMouseEnter={() => handleCellMouseEnter(i, axis)}
          >
            {editing ? (
              <input
                type="text"
                // A bare <input> defaults to a browser-intrinsic min-width
                // around 20 characters, and that floor holds regardless of
                // table-layout - CSS min-width/width alone can't override
                // it, only this attribute can. Values here are always short
                // whole numbers (see toFixed(0) below); a 3- or 4-digit
                // value still fits by scrolling within the box once typed,
                // this only sets the box's resting size.
                size={3}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => handleCellKeyDown(e, i, axis)}
                onBlur={() => handleCellBlur(i, axis)}
                onFocus={(e) => e.target.select()}
                autoFocus
              />
            ) : (
              // TunerStudio's own bin-value strip shows whole numbers, no
              // decimals ("14", not "14.30" or even "14.3") - matching it
              // also buys back the width this table needs to fit its
              // columns without scrolling.
              value.toFixed(0)
            )}
          </td>
        );
      })}
    </tr>
  );

  const renderCurveTableBody = () => {
    const additionalSeries = data.additional_y_series ?? [];
    return (
      <>
        {renderCurveTableAxisRow(
          'y',
          data.primary_y_line_label ?? data.y_label,
          localYBins,
          yAxis,
          !!data.y_bins_read_only,
          additionalSeries.length ? '#f5d742' : undefined,
        )}
        {additionalSeries.map((series, i) =>
          series.visible
            ? renderCurveTableAxisRow(
                i,
                series.label ?? `Series ${i + 2}`,
                localAdditionalSeries[i] ?? [],
                yAxis,
                false,
                ADDITIONAL_SERIES_COLORS[i % ADDITIONAL_SERIES_COLORS.length],
              )
            : null,
        )}
        {renderCurveTableAxisRow('x', data.x_label, localXBins, xAxis, !!data.x_bins_read_only)}
      </>
    );
  };

  return (
    <div
      className={`curve-editor ${embedded ? 'embedded' : 'standalone'}`}
      ref={containerRef}
      tabIndex={0} // Enable keyboard focus for undo/redo shortcuts
    >
      {/* Header - only for standalone mode */}
      {!embedded && (
        <div className="curve-editor-header">
          <button className="back-button" onClick={onBack} title="Back">
            <ArrowLeft size={18} />
          </button>
          <h2 className="curve-title">{displayTitle}</h2>
          <div className="curve-toolbar">
            <button 
              className="toolbar-btn" 
              title="Undo (Ctrl+Z)" 
              onClick={undo}
              disabled={historyIndex < 0}
            >
              <Undo2 size={16} />
            </button>
            <button 
              className="toolbar-btn" 
              title="Redo (Ctrl+Y)" 
              onClick={redo}
              disabled={historyIndex >= history.length - 1}
            >
              <Redo2 size={16} />
            </button>
            <div className="toolbar-separator" />
            <button className="toolbar-btn" title="Save">
              <Save size={16} />
            </button>
            <button className="toolbar-btn" title="Burn to ECU">
              <Flame size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Title for embedded mode */}
      {embedded && (
        <div className="curve-embedded-title">{displayTitle}</div>
      )}

      <div className="curve-content">
        {/* Chart area */}
        <div className="curve-chart-container" ref={chartContainerRef} onContextMenu={handleContextMenu}>
          <svg
            ref={svgRef}
            width={chartWidth}
            height={chartHeight}
            className="curve-svg"
            style={{ cursor: isDragging ? 'ns-resize' : 'crosshair' }}
            onMouseDown={handleChartMouseDown}
          >
            {/* Background */}
            <rect
              x={padding.left}
              y={padding.top}
              width={chartWidth - padding.left - padding.right}
              height={chartHeight - padding.top - padding.bottom}
              fill="#1a1a1a"
            />

            {/* Grid lines */}
            {gridLines.map((line, i) => (
              <line
                key={i}
                x1={line.x1}
                y1={line.y1}
                x2={line.x2}
                y2={line.y2}
                stroke={line.isAxis ? '#666' : '#333'}
                strokeWidth={line.isAxis ? 2 : 1}
              />
            ))}

            {/* X axis labels */}
            {gridLines
              .filter(l => l.x1 === l.x2 && l.label) // Vertical lines = X axis
              .map((line, i) => (
                <text
                  key={`x-${i}`}
                  x={line.x1}
                  y={chartHeight - padding.bottom + 15}
                  textAnchor="middle"
                  fill="#888"
                  fontSize="10"
                >
                  {line.label}
                </text>
              ))}

            {/* Y axis labels */}
            {gridLines
              .filter(l => l.y1 === l.y2 && l.label) // Horizontal lines = Y axis
              .map((line, i) => (
                <text
                  key={`y-${i}`}
                  x={padding.left - 5}
                  y={line.y1 + 3}
                  textAnchor="end"
                  fill="#888"
                  fontSize="10"
                >
                  {line.label}
                </text>
              ))}

            {/* Axis titles */}
            <text
              x={chartWidth / 2}
              y={chartHeight - 5}
              textAnchor="middle"
              fill="#aaa"
              fontSize="12"
            >
              {data.x_label}
            </text>
            <text
              x={12}
              y={chartHeight / 2}
              textAnchor="middle"
              fill="#aaa"
              fontSize="12"
              transform={`rotate(-90, 12, ${chartHeight / 2})`}
            >
              {data.y_label}
            </text>

            {/* Additional Y series (§9.2.1) - editable via their own table
                row (see renderCurveTableBody), but not draggable on the
                chart itself; the primary series below stays the only one
                with chart-point handles. Drawn first so the primary line
                and its points sit on top. Reads localAdditionalSeries (not
                the data prop) so a table edit here updates the chart
                immediately, same as the primary line. */}
            {(data.additional_y_series ?? []).map((series, seriesIdx) => {
              if (!series.visible) return null;
              const color = ADDITIONAL_SERIES_COLORS[seriesIdx % ADDITIONAL_SERIES_COLORS.length];
              const seriesValues = localAdditionalSeries[seriesIdx] ?? series.values;
              const points = localXBins
                .map((x, i) => `${scaleX(x ?? 0)},${scaleY(seriesValues[i] ?? 0)}`)
                .join(' ');
              return (
                <polyline
                  key={`series-${seriesIdx}`}
                  points={points}
                  fill="none"
                  stroke={color}
                  strokeWidth="1.5"
                  opacity={0.85}
                />
              );
            })}

            {/* Data line */}
            <polyline
              points={polylinePoints}
              fill="none"
              stroke="#f5d742"
              strokeWidth="2"
            />

            {/* Data points */}
            {localXBins.map((x, i) => (
              <circle
                key={i}
                cx={scaleX(x ?? 0)}
                cy={scaleY(localYBins[i] ?? 0)}
                r={selectedPoint === i ? 8 : 6}
                fill={selectedPoint === i ? '#fff' : '#f5d742'}
                stroke="#000"
                strokeWidth="2"
                style={{ cursor: 'ns-resize' }}
                onMouseDown={(e) => handlePointMouseDown(e, i)}
              />
            ))}

            {/* Live cursor */}
            {liveCursor && (
              <>
                {/* Vertical line */}
                <line
                  x1={liveCursor.screenX}
                  y1={padding.top}
                  x2={liveCursor.screenX}
                  y2={chartHeight - padding.bottom}
                  stroke="#ff4444"
                  strokeWidth="1"
                  strokeDasharray="4,2"
                />
                {/* Highlight point */}
                <circle
                  cx={liveCursor.screenX}
                  cy={liveCursor.screenY}
                  r="5"
                  fill="#ff4444"
                  stroke="#fff"
                  strokeWidth="2"
                />
              </>
            )}
          </svg>

          {/* Multi-series legend (§9.2.1) - only shown when the curve has more than one yBins row */}
          {!!data.additional_y_series?.length && (
            <div className="curve-series-legend">
              <span className="curve-series-legend-entry">
                <span className="curve-series-swatch" style={{ background: '#f5d742' }} />
                {data.primary_y_line_label ?? data.y_label}
              </span>
              {data.additional_y_series.map((series, i) =>
                series.visible ? (
                  <span key={i} className="curve-series-legend-entry">
                    <span
                      className="curve-series-swatch"
                      style={{ background: ADDITIONAL_SERIES_COLORS[i % ADDITIONAL_SERIES_COLORS.length] }}
                    />
                    {series.label ?? `Series ${i + 2}`}
                  </span>
                ) : null
              )}
            </div>
          )}
        </div>

        {/* Bottom section: gauge + data table (embedded only uses stacked layout) */}
        {embedded ? (
          <div className="curve-bottom-section">
            <div className="curve-data-table">
          <table>
            <tbody>{renderCurveTableBody()}</tbody>
          </table>
        </div>
            {(gaugeConfig || simpleGaugeInfo) && (
              <GaugeLiveReadout
                className="curve-live-readout"
                gaugeInfo={simpleGaugeInfo}
                gaugeConfig={gaugeConfig}
                value={gaugeValue}
              />
            )}
          </div>
        ) : (
          /* Standalone mode: table beside chart */
          <div className="curve-data-table">
            <table>
              <tbody>{renderCurveTableBody()}</tbody>
            </table>
          </div>
        )}
      </div>

      {/* Context menu for axis scaling */}
      {contextMenu && (
        <div 
          className="curve-context-menu" 
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="context-menu-section">
            <div className="context-menu-header">Y Axis</div>
            <div className="context-menu-item" onClick={setYAxisMin}>Set Minimum...</div>
            <div className="context-menu-item" onClick={setYAxisMax}>Set Maximum...</div>
            <div className="context-menu-item" onClick={toggleYAxisAuto}>
              <input type="checkbox" checked={yAxisOverride.auto} readOnly /> Auto Scale
            </div>
          </div>
          <div className="context-menu-divider" />
          <div className="context-menu-section">
            <div className="context-menu-header">X Axis</div>
            <div className="context-menu-item" onClick={setXAxisMin}>Set Minimum...</div>
            <div className="context-menu-item" onClick={setXAxisMax}>Set Maximum...</div>
            <div className="context-menu-item" onClick={toggleXAxisAuto}>
              <input type="checkbox" checked={xAxisOverride.auto} readOnly /> Auto Scale
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
