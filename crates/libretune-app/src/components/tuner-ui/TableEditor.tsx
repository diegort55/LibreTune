import { useState, useCallback, useRef, useEffect, KeyboardEvent, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { useChannels } from '../../stores/realtimeStore';
import { useHeatmapSettings } from '../../utils/useHeatmapSettings';
import { contrastTextColor } from '../../utils/heatmapColors';
import { useTableYAxisBottom, useTrailFadeSec } from '../../utils/useTableOrientation';
import './TableEditor.css';
import TableEditor3D from '../tables/TableEditor3D';
import TableToolbar from './table-editor/TableToolbar';
import TableContextMenu from './table-editor/TableContextMenu';
import GenerateTableDialog from '../dialogs/GenerateTableDialog';
import { classifyGeneratableTable, generatableTableLabel } from '../../utils/tableGenerator';
import { toTunerTableData, BackendTableData } from '../../types/app';

export interface TableData {
  name: string;
  xAxis: number[];
  yAxis: number[];
  zValues: number[][];
  xLabel?: string;
  yLabel?: string;
  zLabel?: string;
  xUnits?: string;
  yUnits?: string;
  zUnits?: string;
  min?: number;
  max?: number;
  precision?: number;
  /** Output channel name for X-axis (used for live cell highlighting) */
  xOutputChannel?: string;
  /** Output channel name for Y-axis (used for live cell highlighting) */
  yOutputChannel?: string;
}

export interface CellPosition {
  row: number;
  col: number;
}

interface TableEditorProps {
  data: TableData;
  onChange: (newData: TableData) => void;
  onBurn?: () => void;
  followMode?: boolean;
  livePosition?: CellPosition | null;
  showHistoryTrail?: boolean;
}

// Selection can be a single cell or a range
interface Selection {
  start: CellPosition;
  end: CellPosition;
}

// Context menu state
interface ContextMenuState {
  x: number;
  y: number;
  visible: boolean;
}

// Increment settings for step operations
interface IncrementSettings {
  stepAmount: number;      // Amount for > < keys
  stepCount: number;       // Multiplier when Ctrl is held
  stepPercent: number;     // Percentage for Shift operations
}

export function TableEditor({
  data,
  onChange,
  onBurn,
  followMode: _followMode = false,
  livePosition = null,
  showHistoryTrail: _showHistoryTrail = false,
}: TableEditorProps) {
  // Get realtime data from Zustand store - only subscribe to channels needed for live position
  const outputChannels = useMemo(() => {
    const channels: string[] = [];
    if (data.xOutputChannel) channels.push(data.xOutputChannel);
    if (data.yOutputChannel) channels.push(data.yOutputChannel);
    return channels;
  }, [data.xOutputChannel, data.yOutputChannel]);
  const realtimeData = useChannels(outputChannels);

  const [selection, setSelection] = useState<Selection | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [editingCell, setEditingCell] = useState<CellPosition | null>(null);
  const [editValue, setEditValue] = useState('');
  // Axis bin (row/column header) editing - separate from editingCell/editValue
  // above, which are for Z-grid cells only.
  const [editingAxis, setEditingAxis] = useState<{ axis: 'x' | 'y'; index: number } | null>(null);
  const [axisEditValue, setAxisEditValue] = useState('');
  const [clipboard, setClipboard] = useState<number[][] | null>(null);
  const [history, setHistory] = useState<TableData[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const tableRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  
  // Follow mode state (on by default so open tables track the live cursor)
  const [followMode, setFollowMode] = useState(true);
  const [historyTrail, setHistoryTrail] = useState<Array<{ row: number; col: number; time: number }>>([]);
  const trailFadeSec = useTrailFadeSec();
  const TRAIL_DURATION_MS = trailFadeSec > 0 ? trailFadeSec * 1000 : Infinity;
  
  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ x: 0, y: 0, visible: false });
  
  // Original values for reset functionality
  const [originalData, setOriginalData] = useState<TableData | null>(null);
  
  // Increment settings
  const [incrementSettings, setIncrementSettings] = useState<IncrementSettings>({
    stepAmount: 0.1,
    stepCount: 10,
    stepPercent: 1,
  });
  
  // Track if heatmap coloring is enabled
  const [heatmapEnabled, setHeatmapEnabled] = useState(true);

  // Heatmap settings from user preferences
  const { settings: heatmapSettings, getColor: getHeatmapColor } = useHeatmapSettings();

  // Y-axis origin at bottom-left — display-only flip
  const yAxisBottom = useTableYAxisBottom();

  const heatmapScheme = useMemo(() => {
    if (heatmapSettings.valueScheme === 'custom' && heatmapSettings.customValueStops?.length) {
      return heatmapSettings.customValueStops;
    }
    return heatmapSettings.valueScheme ?? 'tunerstudio';
  }, [heatmapSettings]);
  
  // Track if 3D view is enabled
  const [show3D, setShow3D] = useState(false);

  // TunerStudio-style per-table generator (VE / ignition / AFR only).
  const generatableKind = useMemo(() => classifyGeneratableTable(data.name), [data.name]);
  const [showGenerateDialog, setShowGenerateDialog] = useState(false);

  // TunerStudio-compatible .table file import/export for this one table.
  const handleExportTable = useCallback(async () => {
    try {
      const path = await save({
        title: 'Save Table to File',
        defaultPath: `${data.name}.table`,
        filters: [{ name: 'TunerStudio Table', extensions: ['table'] }],
      });
      if (!path) return;
      await invoke('export_table_to_file', { tableName: data.name, path });
    } catch (err) {
      alert(`Failed to save table: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [data.name]);

  const handleImportTable = useCallback(async () => {
    try {
      const path = await open({
        title: 'Load Table from File',
        filters: [{ name: 'TunerStudio Table', extensions: ['table'] }],
        multiple: false,
        directory: false,
      });
      if (!path) return;
      const result = await invoke<BackendTableData>('import_table_from_file', {
        tableName: data.name,
        path,
      });
      onChange(toTunerTableData(result));
    } catch (err) {
      alert(`Failed to load table: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [data.name, onChange]);

  // Store original data on first render
  useEffect(() => {
    if (!originalData) {
      setOriginalData(JSON.parse(JSON.stringify(data)));
    }
  }, [data, originalData]);

  // Helper: Find nearest bin index for a given value
  const findNearestBinIndex = useCallback((value: number, bins: number[]): number => {
    if (bins.length === 0) return 0;
    let nearestIdx = 0;
    let minDiff = Math.abs(bins[0] - value);
    for (let i = 1; i < bins.length; i++) {
      const diff = Math.abs(bins[i] - value);
      if (diff < minDiff) {
        minDiff = diff;
        nearestIdx = i;
      }
    }
    return nearestIdx;
  }, []);

  // Calculate live cursor position from realtime data
  const calculatedLivePosition = useMemo((): CellPosition | null => {
    if (!followMode) return null;
    
    const xChannel = data.xOutputChannel;
    const yChannel = data.yOutputChannel;
    
    if (!xChannel) return null;
    
    const xValue = realtimeData[xChannel];
    if (xValue === undefined) return null;
    
    const col = findNearestBinIndex(xValue, data.xAxis);
    
    // For 1D curves (single row), row is always 0
    if (!yChannel || data.yAxis.length <= 1) {
      return { row: 0, col };
    }
    
    const yValue = realtimeData[yChannel];
    if (yValue === undefined) return { row: 0, col };
    
    const row = findNearestBinIndex(yValue, data.yAxis);
    return { row, col };
  }, [followMode, realtimeData, data.xOutputChannel, data.yOutputChannel, data.xAxis, data.yAxis, findNearestBinIndex]);

  // Merge prop-passed livePosition with calculated one (calculated takes
  // precedence when followMode is on).
  //
  // Identity is stabilized against the previous cell: the raw memo produces a
  // fresh {row, col} object on every realtime tick (~20 Hz), which re-fired
  // the trail effect below and cascaded a state update + re-render even when
  // the cursor stayed inside the same cell — a large slice of the
  // "table open with live data freezes the window" storm (issue #132).
  const livePosRef = useRef<CellPosition | null>(null);
  const stableLivePosition = useMemo(() => {
    const pos = calculatedLivePosition;
    const last = livePosRef.current;
    if (pos && last && pos.row === last.row && pos.col === last.col) {
      return last;
    }
    livePosRef.current = pos;
    return pos;
  }, [calculatedLivePosition]);
  const effectiveLivePosition = followMode ? stableLivePosition : livePosition;

  // Update history trail when live position changes
  useEffect(() => {
    if (!followMode || !effectiveLivePosition) return;

    const now = Date.now();
    const newEntry = { row: effectiveLivePosition.row, col: effectiveLivePosition.col, time: now };

    setHistoryTrail((prev) => {
      // Oldest entry first: if it has not expired, nothing has.
      const nothingExpired =
        prev.length === 0 || now - prev[0].time < TRAIL_DURATION_MS;

      // Same cell as the last entry: nothing to add. Return the previous
      // array unchanged when nothing expired, so no re-render is queued.
      const last = prev[prev.length - 1];
      if (last && last.row === newEntry.row && last.col === newEntry.col) {
        return nothingExpired
          ? prev
          : prev.filter((e) => now - e.time < TRAIL_DURATION_MS);
      }

      const base = nothingExpired
        ? prev
        : prev.filter((e) => now - e.time < TRAIL_DURATION_MS);
      return [...base, newEntry];
    });
  }, [followMode, effectiveLivePosition, TRAIL_DURATION_MS]);

  // Trail cells fade over TRAIL_DURATION_MS, so something must trigger a
  // periodic re-render while entries exist: this is that tick (~5 Hz) plus
  // expiry cleanup. It must also return the previous array when nothing
  // expired, or it would queue a re-render of its own on every firing.
  const trailActiveRef = useRef(false);
  trailActiveRef.current = historyTrail.length > 0;
  const [, setTrailFadeTick] = useState(0);
  useEffect(() => {
    if (!followMode) {
      setHistoryTrail([]);
      return;
    }

    const interval = setInterval(() => {
      const now = Date.now();
      setHistoryTrail((prev) => {
        const filtered = prev.filter((entry) => now - entry.time < TRAIL_DURATION_MS);
        return filtered.length === prev.length ? prev : filtered;
      });
      if (trailActiveRef.current) {
        setTrailFadeTick((t) => (t + 1) % 1_000_000);
      }
    }, 200);

    return () => clearInterval(interval);
  }, [followMode, TRAIL_DURATION_MS]);

  // Min/max of the Z grid, computed once per data change. `data.min`/`max`
  // are never populated today, so getValueColor used to flatten the whole
  // grid (256 elements) on every call — called twice per cell per render at
  // up to ~40 renders/sec while streaming, which saturated the UI thread
  // (issue #132).
  const zBounds = useMemo(() => {
    if (data.min !== undefined && data.max !== undefined) {
      return { min: data.min, max: data.max };
    }
    let min = Infinity;
    let max = -Infinity;
    for (const row of data.zValues) {
      for (const v of row) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    return { min, max };
  }, [data.min, data.max, data.zValues]);

  // Trail lookup by cell — one Map build per trail change instead of a
  // linear find() per cell per render. When a cell was re-entered (A→B→A)
  // the Map keeps the newest entry, which is also the correct fade (find()
  // returned the oldest and showed a freshly re-entered cell as faded).
  const trailMap = useMemo(() => {
    const m = new Map<string, { row: number; col: number; time: number }>();
    for (const e of historyTrail) m.set(`${e.row},${e.col}`, e);
    return m;
  }, [historyTrail]);

  // Calculate color for value based on min/max
  const getValueColor = useCallback((value: number) => {
    if (!heatmapEnabled) return 'var(--table-cell-bg)';

    const { min, max } = zBounds;
    if (min === max) return 'var(--table-cell-bg)';

    return getHeatmapColor(value, min, max, 'value');
  }, [heatmapEnabled, zBounds, getHeatmapColor]);

  // Get selected cells as array of positions
  const getSelectedCells = useCallback((): CellPosition[] => {
    if (!selection) return [];
    
    const cells: CellPosition[] = [];
    const minRow = Math.min(selection.start.row, selection.end.row);
    const maxRow = Math.max(selection.start.row, selection.end.row);
    const minCol = Math.min(selection.start.col, selection.end.col);
    const maxCol = Math.max(selection.start.col, selection.end.col);
    
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        cells.push({ row, col });
      }
    }
    return cells;
  }, [selection]);

  // Push to history before making changes
  const pushHistory = useCallback(() => {
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(JSON.parse(JSON.stringify(data)));
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
  }, [data, history, historyIndex]);

  // Apply a freshly generated grid (from GenerateTableDialog) as one undoable
  // edit, optionally with rebuilt RPM/load axes. Persists to the backend cache
  // so the result survives closing/reopening the table (otherwise a reopen
  // re-fetches the original definition).
  const applyGeneratedValues = useCallback(
    async (result: { zValues: number[][]; xBins?: number[]; yBins?: number[] }) => {
      pushHistory();
      try {
        // Persist rebuilt axes first (writes the bin constants + re-interpolates),
        // then overwrite the Z grid with the generated values.
        if (result.xBins && result.yBins) {
          await invoke('rebin_table', {
            tableName: data.name,
            newXBins: result.xBins,
            newYBins: result.yBins,
            // The generated Z grid is written right after, so no need to
            // interpolate the old values onto the new bins here.
            interpolateZ: false,
          });
        }
        await invoke('update_table_data', {
          tableName: data.name,
          zValues: result.zValues,
        });
      } catch (e) {
        console.error('Failed to persist generated table:', e);
      }
      onChange({
        ...data,
        zValues: result.zValues,
        xAxis: result.xBins ?? data.xAxis,
        yAxis: result.yBins ?? data.yAxis,
      });
    },
    [data, onChange, pushHistory],
  );

  // Undo
  const undo = useCallback(() => {
    if (historyIndex >= 0) {
      onChange(history[historyIndex]);
      setHistoryIndex(historyIndex - 1);
    }
  }, [history, historyIndex, onChange]);

  // Redo
  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      setHistoryIndex(historyIndex + 1);
      onChange(history[historyIndex + 1]);
    }
  }, [history, historyIndex, onChange]);

  // Table operations
  const setEqual = useCallback((value: number) => {
    const cells = getSelectedCells();
    if (cells.length === 0) return;
    
    pushHistory();
    const newZValues = data.zValues.map((row) => [...row]);
    cells.forEach(({ row, col }) => {
      newZValues[row][col] = value;
    });
    onChange({ ...data, zValues: newZValues });
  }, [data, getSelectedCells, onChange, pushHistory]);

  const adjustValues = useCallback((delta: number) => {
    const cells = getSelectedCells();
    if (cells.length === 0) return;
    
    pushHistory();
    const newZValues = data.zValues.map((row) => [...row]);
    cells.forEach(({ row, col }) => {
      newZValues[row][col] = Number((newZValues[row][col] + delta).toFixed(data.precision ?? 2));
    });
    onChange({ ...data, zValues: newZValues });
  }, [data, getSelectedCells, onChange, pushHistory]);

  const scaleValues = useCallback((factor: number) => {
    const cells = getSelectedCells();
    if (cells.length === 0) return;
    
    pushHistory();
    const newZValues = data.zValues.map((row) => [...row]);
    cells.forEach(({ row, col }) => {
      newZValues[row][col] = Number((newZValues[row][col] * factor).toFixed(data.precision ?? 2));
    });
    onChange({ ...data, zValues: newZValues });
  }, [data, getSelectedCells, onChange, pushHistory]);

  const interpolate = useCallback(() => {
    const cells = getSelectedCells();
    if (cells.length < 3) return; // Need at least 3 cells
    
    pushHistory();
    const newZValues = data.zValues.map((row) => [...row]);
    
    // Determine if horizontal or vertical interpolation
    const rows = [...new Set(cells.map((c) => c.row))].sort((a, b) => a - b);
    const cols = [...new Set(cells.map((c) => c.col))].sort((a, b) => a - b);
    
    if (rows.length === 1 && cols.length > 2) {
      // Horizontal interpolation
      const row = rows[0];
      const startVal = newZValues[row][cols[0]];
      const endVal = newZValues[row][cols[cols.length - 1]];
      const step = (endVal - startVal) / (cols.length - 1);
      
      cols.forEach((col, i) => {
        newZValues[row][col] = Number((startVal + step * i).toFixed(data.precision ?? 2));
      });
    } else if (cols.length === 1 && rows.length > 2) {
      // Vertical interpolation
      const col = cols[0];
      const startVal = newZValues[rows[0]][col];
      const endVal = newZValues[rows[rows.length - 1]][col];
      const step = (endVal - startVal) / (rows.length - 1);
      
      rows.forEach((row, i) => {
        newZValues[row][col] = Number((startVal + step * i).toFixed(data.precision ?? 2));
      });
    }
    
    onChange({ ...data, zValues: newZValues });
  }, [data, getSelectedCells, onChange, pushHistory]);

  const smooth = useCallback(() => {
    const cells = getSelectedCells();
    if (cells.length === 0) return;
    
    pushHistory();
    const newZValues = data.zValues.map((row) => [...row]);
    
    // Apply 3x3 weighted average smoothing
    cells.forEach(({ row, col }) => {
      let sum = 0;
      let weight = 0;
      
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const r = row + dr;
          const c = col + dc;
          if (r >= 0 && r < data.zValues.length && c >= 0 && c < data.zValues[0].length) {
            const w = dr === 0 && dc === 0 ? 2 : 1;
            sum += data.zValues[r][c] * w;
            weight += w;
          }
        }
      }
      
      newZValues[row][col] = Number((sum / weight).toFixed(data.precision ?? 2));
    });
    
    onChange({ ...data, zValues: newZValues });
  }, [data, getSelectedCells, onChange, pushHistory]);

  // Interpolate horizontal only (H key)
  const interpolateHorizontal = useCallback(() => {
    const cells = getSelectedCells();
    if (cells.length < 2) return;
    
    pushHistory();
    const newZValues = data.zValues.map((row) => [...row]);
    
    // Group by row and interpolate each row independently
    const rowGroups = new Map<number, number[]>();
    cells.forEach(({ row, col }) => {
      if (!rowGroups.has(row)) rowGroups.set(row, []);
      rowGroups.get(row)!.push(col);
    });
    
    rowGroups.forEach((cols, row) => {
      cols.sort((a, b) => a - b);
      if (cols.length < 2) return;
      
      const startVal = newZValues[row][cols[0]];
      const endVal = newZValues[row][cols[cols.length - 1]];
      const step = (endVal - startVal) / (cols.length - 1);
      
      cols.forEach((col, i) => {
        newZValues[row][col] = Number((startVal + step * i).toFixed(data.precision ?? 2));
      });
    });
    
    onChange({ ...data, zValues: newZValues });
  }, [data, getSelectedCells, onChange, pushHistory]);

  // Interpolate vertical only (V key)
  const interpolateVertical = useCallback(() => {
    const cells = getSelectedCells();
    if (cells.length < 2) return;
    
    pushHistory();
    const newZValues = data.zValues.map((row) => [...row]);
    
    // Group by column and interpolate each column independently
    const colGroups = new Map<number, number[]>();
    cells.forEach(({ row, col }) => {
      if (!colGroups.has(col)) colGroups.set(col, []);
      colGroups.get(col)!.push(row);
    });
    
    colGroups.forEach((rows, col) => {
      rows.sort((a, b) => a - b);
      if (rows.length < 2) return;
      
      const startVal = newZValues[rows[0]][col];
      const endVal = newZValues[rows[rows.length - 1]][col];
      const step = (endVal - startVal) / (rows.length - 1);
      
      rows.forEach((row, i) => {
        newZValues[row][col] = Number((startVal + step * i).toFixed(data.precision ?? 2));
      });
    });
    
    onChange({ ...data, zValues: newZValues });
  }, [data, getSelectedCells, onChange, pushHistory]);

  // Flood fill (fill up and right from selection) - F key
  const floodFill = useCallback(() => {
    if (!selection) return;
    
    pushHistory();
    const newZValues = data.zValues.map((row) => [...row]);
    const sourceRow = Math.min(selection.start.row, selection.end.row);
    const sourceCol = Math.min(selection.start.col, selection.end.col);
    const value = data.zValues[sourceRow][sourceCol];
    
    // Fill from source cell up to top-right corner
    for (let row = sourceRow; row >= 0; row--) {
      for (let col = sourceCol; col < data.zValues[0].length; col++) {
        newZValues[row][col] = value;
      }
    }
    
    onChange({ ...data, zValues: newZValues });
  }, [selection, data, onChange, pushHistory]);

  // Reset to original values (Escape with selection)
  const resetToOriginal = useCallback(() => {
    const cells = getSelectedCells();
    if (cells.length === 0 || !originalData) return;
    
    pushHistory();
    const newZValues = data.zValues.map((row) => [...row]);
    cells.forEach(({ row, col }) => {
      if (row < originalData.zValues.length && col < originalData.zValues[0].length) {
        newZValues[row][col] = originalData.zValues[row][col];
      }
    });
    
    onChange({ ...data, zValues: newZValues });
  }, [data, getSelectedCells, onChange, pushHistory, originalData]);

  // Select all cells (Ctrl+A)
  const selectAll = useCallback(() => {
    if (data.zValues.length === 0 || data.zValues[0].length === 0) return;
    setSelection({
      start: { row: 0, col: 0 },
      end: { row: data.zValues.length - 1, col: data.zValues[0].length - 1 }
    });
  }, [data.zValues]);

  // Copy/paste
  const copySelection = useCallback(() => {
    if (!selection) return;
    
    const minRow = Math.min(selection.start.row, selection.end.row);
    const maxRow = Math.max(selection.start.row, selection.end.row);
    const minCol = Math.min(selection.start.col, selection.end.col);
    const maxCol = Math.max(selection.start.col, selection.end.col);
    
    const copied: number[][] = [];
    for (let row = minRow; row <= maxRow; row++) {
      const rowData: number[] = [];
      for (let col = minCol; col <= maxCol; col++) {
        rowData.push(data.zValues[row][col]);
      }
      copied.push(rowData);
    }
    setClipboard(copied);
  }, [selection, data.zValues]);

  const pasteSelection = useCallback(() => {
    if (!selection || !clipboard) return;
    
    pushHistory();
    const newZValues = data.zValues.map((row) => [...row]);
    const startRow = Math.min(selection.start.row, selection.end.row);
    const startCol = Math.min(selection.start.col, selection.end.col);
    
    clipboard.forEach((row, dr) => {
      row.forEach((value, dc) => {
        const r = startRow + dr;
        const c = startCol + dc;
        if (r < newZValues.length && c < newZValues[0].length) {
          newZValues[r][c] = value;
        }
      });
    });
    
    onChange({ ...data, zValues: newZValues });
  }, [selection, clipboard, data, onChange, pushHistory]);

  // Format value for display - axis headers below use this too, not just Z
  // cells, so both round the same way and neither can show raw float noise.
  // Every WRITE path in this file (handleIncrease/handleDecrease/setEqual/
  // interpolate/smooth/finishEdit) already falls back to 2 decimals when
  // data.precision is unset - this used to fall back to 1, showing "4.2"
  // for a value the table was actually storing as "4.20".
  const formatValue = useCallback((value: number) => {
    return value.toFixed(data.precision ?? 2);
  }, [data.precision]);

  // Opens a Z cell for editing - a plain click (see handleMouseUp below).
  // formatValue (not raw String()) seeds the box, so it can't show float
  // noise a value read straight off ECU bytes may carry (same fix as the
  // axis headers above).
  const openCellEdit = useCallback((row: number, col: number) => {
    setEditingCell({ row, col });
    setEditValue(formatValue(data.zValues[row][col]));
  }, [data.zValues, formatValue]);

  // gestureActiveRef marks that a mousedown just started ON A GRID CELL, so
  // the matching global mouseup (handleMouseUp is a document-level
  // listener - see the useEffect below - so it also fires for a mouseup
  // anywhere else on the page) knows this specific mouseup is the one that
  // finishes it, not some unrelated click while an old selection is still
  // sitting around from earlier.
  const gestureActiveRef = useRef(false);

  const handleCellMouseDown = useCallback((row: number, col: number, e: React.MouseEvent) => {
    gestureActiveRef.current = true;
    if (e.shiftKey && selection) {
      // Extend selection
      setSelection({ ...selection, end: { row, col } });
    } else {
      // Start new selection
      setSelection({ start: { row, col }, end: { row, col } });
      setIsSelecting(true);
    }
  }, [selection]);

  const handleCellMouseEnter = useCallback((row: number, col: number) => {
    if (isSelecting && selection) {
      setSelection({ ...selection, end: { row, col } });
    }
  }, [isSelecting, selection]);

  // A click (1-cell selection), a drag across several cells, or a
  // shift-click range-extend all end here the same way: open the anchor
  // cell (selection.start) for editing. For a single cell that's just "you
  // clicked a cell to edit it" as before; for a multi-cell selection,
  // finishEdit below applies whatever gets typed to every selected cell at
  // once instead of only the anchor - the same drag-select-then-type-a-
  // value-and-Enter pattern the curve editor uses.
  const handleMouseUp = useCallback(() => {
    setIsSelecting(false);
    if (gestureActiveRef.current && selection) {
      gestureActiveRef.current = false;
      openCellEdit(selection.start.row, selection.start.col);
    }
  }, [selection, openCellEdit]);

  // Handle edit completion. More than one cell selected (a drag, not a
  // plain click) applies the typed value to every selected cell at once,
  // not just the one showing the input box - same pattern as the curve
  // editor's multi-cell drag-select.
  const finishEdit = useCallback((save: boolean) => {
    if (editingCell && save) {
      const value = parseFloat(editValue);
      if (!isNaN(value)) {
        const selectedCells = getSelectedCells();
        const targets = selectedCells.length > 1 ? selectedCells : [editingCell];

        // Single-cell no-op guard only - a bulk edit always applies, even
        // if the anchor cell's own value looks unchanged, since the other
        // selected cells may still need it. Prevents a plain click-away
        // (open then blur with nothing typed) from truncating a value's
        // real precision to whatever formatValue happened to round it to.
        const isNoOp = targets.length === 1
          && value === Number(formatValue(data.zValues[editingCell.row][editingCell.col]));

        if (!isNoOp) {
          pushHistory();
          const newZValues = data.zValues.map((row) => [...row]);
          const rounded = Number(value.toFixed(data.precision ?? 2));
          targets.forEach(({ row, col }) => {
            newZValues[row][col] = rounded;
          });
          onChange({ ...data, zValues: newZValues });
        }
      }
    }
    setEditingCell(null);
    setEditValue('');
  }, [editingCell, editValue, data, onChange, pushHistory, getSelectedCells, formatValue]);

  // Axis bin (row/column header) editing. A single click opens the cell for
  // editing right away - unlike the Z grid's headers-select-for-bulk-ops
  // convention over in TableGrid.tsx, these headers have no other click
  // behavior to preserve, so there's no reason to require a double-click
  // first. formatValue (not raw .toString()) seeds the edit box, since a
  // value read straight off ECU bytes can carry float noise
  // (413.700000000000005) that the rounded display never showed.
  const handleAxisClick = useCallback(
    (axis: 'x' | 'y', index: number) => {
      setEditingAxis({ axis, index });
      setAxisEditValue(formatValue(axis === 'x' ? data.xAxis[index] : data.yAxis[index]));
    },
    [data.xAxis, data.yAxis, formatValue],
  );

  const finishAxisEdit = useCallback(
    (save: boolean) => {
      if (editingAxis && save) {
        const value = parseFloat(axisEditValue);
        const original = editingAxis.axis === 'x' ? data.xAxis[editingAxis.index] : data.yAxis[editingAxis.index];
        // Skip the write (and the pushHistory below) if nothing was
        // actually typed - a plain click-away shouldn't spam an edit that
        // just re-sends the same rounded value, or an undo-history entry
        // for a no-op.
        if (!isNaN(value) && value !== Number(formatValue(original))) {
          pushHistory();
          if (editingAxis.axis === 'x') {
            const newXAxis = [...data.xAxis];
            newXAxis[editingAxis.index] = value;
            onChange({ ...data, xAxis: newXAxis });
          } else {
            const newYAxis = [...data.yAxis];
            newYAxis[editingAxis.index] = value;
            onChange({ ...data, yAxis: newYAxis });
          }
        }
      }
      setEditingAxis(null);
      setAxisEditValue('');
    },
    [editingAxis, axisEditValue, data, onChange, pushHistory, formatValue],
  );

  const handleAxisKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        finishAxisEdit(true);
      } else if (e.key === 'Escape') {
        setEditingAxis(null);
        setAxisEditValue('');
      }
    },
    [finishAxisEdit],
  );

  // Keyboard navigation
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (editingCell) {
      if (e.key === 'Enter') {
        finishEdit(true);
      } else if (e.key === 'Escape') {
        finishEdit(false);
      }
      return;
    }

    if (!selection) return;

    const { row, col } = selection.end;
    const multiplier = e.ctrlKey ? 5 : 1;
    const delta = e.shiftKey ? 1 : 0.1;

    // With the bottom-left origin, visually "up" is the next data row
    const upDelta = yAxisBottom ? 1 : -1;

    switch (e.key) {
      case 'ArrowUp': {
        e.preventDefault();
        const upRow = row + upDelta;
        if (upRow >= 0 && upRow < data.zValues.length) {
          const newPos = { row: upRow, col };
          setSelection({ start: e.shiftKey ? selection.start : newPos, end: newPos });
        }
        break;
      }
      case 'ArrowDown': {
        e.preventDefault();
        const downRow = row - upDelta;
        if (downRow >= 0 && downRow < data.zValues.length) {
          const newPos = { row: downRow, col };
          setSelection({ start: e.shiftKey ? selection.start : newPos, end: newPos });
        }
        break;
      }
      case 'ArrowLeft':
        e.preventDefault();
        if (col > 0) {
          const newPos = { row, col: col - 1 };
          setSelection({ start: e.shiftKey ? selection.start : newPos, end: newPos });
        }
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (col < data.zValues[0].length - 1) {
          const newPos = { row, col: col + 1 };
          setSelection({ start: e.shiftKey ? selection.start : newPos, end: newPos });
        }
        break;
      case '=':
        e.preventDefault();
        const avgValue = getSelectedCells().reduce((sum, c) => sum + data.zValues[c.row][c.col], 0) / getSelectedCells().length;
        setEqual(Number(avgValue.toFixed(data.precision ?? 2)));
        break;
      case '>':
      case '.':
        e.preventDefault();
        adjustValues(delta * multiplier);
        break;
      case '<':
      case ',':
        e.preventDefault();
        adjustValues(-delta * multiplier);
        break;
      // Page keys use fixed steps: 0.1 plain, 1 with Shift, 0.05 with Ctrl
      case 'PageUp':
        e.preventDefault();
        adjustValues(e.shiftKey ? 1 : e.ctrlKey ? 0.05 : 0.1);
        break;
      case 'PageDown':
        e.preventDefault();
        adjustValues(e.shiftKey ? -1 : e.ctrlKey ? -0.05 : -0.1);
        break;
      case '+':
        e.preventDefault();
        adjustValues(1 * multiplier);
        break;
      case '-':
        e.preventDefault();
        adjustValues(-1 * multiplier);
        break;
      case '*':
        e.preventDefault();
        scaleValues(1.01 * multiplier);
        break;
      case '/':
        e.preventDefault();
        interpolate();
        break;
      case 's':
      case 'S':
        e.preventDefault();
        smooth();
        break;
      case 'f':
      case 'F':
        if (!e.ctrlKey) {
          e.preventDefault();
          if (data.xOutputChannel) {
            setFollowMode(!followMode);
          }
        }
        break;
      case 'c':
        if (e.ctrlKey) {
          e.preventDefault();
          copySelection();
        }
        break;
      case 'z':
        if (e.ctrlKey) {
          e.preventDefault();
          undo();
        }
        break;
      case 'y':
        if (e.ctrlKey) {
          e.preventDefault();
          redo();
        }
        break;
      case 'a':
        if (e.ctrlKey) {
          e.preventDefault();
          selectAll();
        }
        break;
      case 'h':
      case 'H':
        e.preventDefault();
        interpolateHorizontal();
        break;
      case 'v':
        if (e.ctrlKey) {
          e.preventDefault();
          pasteSelection();
        } else {
          e.preventDefault();
          interpolateVertical();
        }
        break;
      case 'Escape':
        e.preventDefault();
        resetToOriginal();
        break;
      case 'Enter':
        e.preventDefault();
        openCellEdit(row, col);
        break;
    }
    // Keep handled keys (notably "/") from also reaching document-level
    // shortcuts like Sidebar's "/ focuses search" — preventDefault alone
    // doesn't stop native bubbling, so search was stealing focus right
    // after an interpolate, breaking arrow-key navigation in the table.
    if (e.defaultPrevented) {
      e.stopPropagation();
    }
  }, [
    selection, editingCell, data, finishEdit, getSelectedCells, setEqual,
    adjustValues, scaleValues, interpolate, interpolateHorizontal, interpolateVertical,
    smooth, copySelection, pasteSelection, selectAll, resetToOriginal, floodFill,
    undo, redo, openCellEdit, followMode, setFollowMode, yAxisBottom
  ]);

  // Focus input when editing
  useEffect(() => {
    if (editingCell && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingCell]);

  // Add mouse up listener
  useEffect(() => {
    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, [handleMouseUp]);

  // Check if cell is selected
  const isCellSelected = useCallback((row: number, col: number) => {
    if (!selection) return false;
    const minRow = Math.min(selection.start.row, selection.end.row);
    const maxRow = Math.max(selection.start.row, selection.end.row);
    const minCol = Math.min(selection.start.col, selection.end.col);
    const maxCol = Math.max(selection.start.col, selection.end.col);
    return row >= minRow && row <= maxRow && col >= minCol && col <= maxCol;
  }, [selection]);

  // Context menu handler
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, visible: true });
  }, []);

  // Close context menu
  const closeContextMenu = useCallback(() => {
    setContextMenu({ ...contextMenu, visible: false });
  }, [contextMenu]);

  // Close context menu on click outside
  useEffect(() => {
    const handleClick = () => closeContextMenu();
    if (contextMenu.visible) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [contextMenu.visible, closeContextMenu]);

  return (
    <div 
      className="table-editor" 
      ref={tableRef} 
      tabIndex={0} 
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
    >
      {/* Context Menu */}
      {contextMenu.visible && (
        <TableContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
          hasSelection={!!selection}
          hasClipboard={!!clipboard}
          onResetToOriginal={resetToOriginal}
          onSetValue={() => {
            const value = prompt('Enter value:');
            if (value) setEqual(parseFloat(value));
            closeContextMenu();
          }}
          onStepUp={() => { adjustValues(incrementSettings.stepAmount); closeContextMenu(); }}
          onStepDown={() => { adjustValues(-incrementSettings.stepAmount); closeContextMenu(); }}
          onAddAmount={() => {
            const amt = prompt('Enter amount to add:');
            if (amt) adjustValues(parseFloat(amt));
            closeContextMenu();
          }}
          onSubtractAmount={() => {
            const amt = prompt('Enter amount to subtract:');
            if (amt) adjustValues(-parseFloat(amt));
            closeContextMenu();
          }}
          onMultiplyBy={() => {
            const factor = prompt('Enter multiplier (e.g., 1.02 for +2%):');
            if (factor) scaleValues(parseFloat(factor));
            closeContextMenu();
          }}
          onInterpolate={() => { interpolate(); closeContextMenu(); }}
          onInterpolateHorizontal={() => { interpolateHorizontal(); closeContextMenu(); }}
          onInterpolateVertical={() => { interpolateVertical(); closeContextMenu(); }}
          onSmooth={() => { smooth(); closeContextMenu(); }}
          onFloodFill={() => { floodFill(); closeContextMenu(); }}
          onCopy={() => { copySelection(); closeContextMenu(); }}
          onPaste={() => { pasteSelection(); closeContextMenu(); }}
          onSetStepAmount={() => {
            const amt = prompt('Enter step amount:', String(incrementSettings.stepAmount));
            if (amt) setIncrementSettings({ ...incrementSettings, stepAmount: parseFloat(amt) });
            closeContextMenu();
          }}
          onSetStepCount={() => {
            const count = prompt('Enter step multiplier (Ctrl key):', String(incrementSettings.stepCount));
            if (count) setIncrementSettings({ ...incrementSettings, stepCount: parseInt(count) });
            closeContextMenu();
          }}
          onSetStepPercent={() => {
            const pct = prompt('Enter step percent (Shift key):', String(incrementSettings.stepPercent));
            if (pct) setIncrementSettings({ ...incrementSettings, stepPercent: parseFloat(pct) });
            closeContextMenu();
          }}
          onToggleHeatmap={() => { setHeatmapEnabled(!heatmapEnabled); closeContextMenu(); }}
          heatmapEnabled={heatmapEnabled}
        />
      )}

      {/* Toolbar */}
      <TableToolbar
        onSetEqual={() => {
          const value = prompt('Enter value:');
          if (value) setEqual(parseFloat(value));
        }}
        onIncrease={() => adjustValues(0.1)}
        onDecrease={() => adjustValues(-0.1)}
        onIncreaseMore={() => adjustValues(1)}
        onDecreaseMore={() => adjustValues(-1)}
        onScale={() => {
          const factor = prompt('Enter scale factor (e.g., 1.02 for +2%):');
          if (factor) scaleValues(parseFloat(factor));
        }}
        onInterpolate={interpolate}
        onSmooth={smooth}
        onCopy={copySelection}
        onPaste={pasteSelection}
        onUndo={undo}
        onRedo={redo}
        onBurn={onBurn}
        hasSelection={!!selection}
        hasClipboard={!!clipboard}
        canUndo={historyIndex >= 0}
        canRedo={historyIndex < history.length - 1}
        followMode={followMode}
        onToggleFollowMode={() => setFollowMode(!followMode)}
        hasOutputChannels={!!data.xOutputChannel}
        show3D={show3D}
        onToggle3D={() => setShow3D(!show3D)}
        onGenerate={generatableKind ? () => setShowGenerateDialog(true) : undefined}
        generatableLabel={generatableKind ? generatableTableLabel(generatableKind) : undefined}
        onImportTable={handleImportTable}
        onExportTable={handleExportTable}
      />

      {/* 3D View */}
      {show3D && (
        <TableEditor3D
          title={data.name}
          x_bins={data.xAxis}
          y_bins={data.yAxis}
          z_values={data.zValues}
          x_label={data.xLabel}
          y_label={data.yLabel}
          z_label={data.zLabel}
          x_units={data.xUnits}
          y_units={data.yUnits}
          z_units={data.zUnits}
          onBack={() => setShow3D(false)}
          selectedCell={selection ? { x: selection.start.col, y: selection.start.row } : null}
          liveCell={effectiveLivePosition ? { x: effectiveLivePosition.col, y: effectiveLivePosition.row } : null}
          historyTrail={followMode ? historyTrail : undefined}
          heatmapScheme={heatmapScheme}
        />
      )}

      {/* Table */}
      {!show3D && (
      <div className="table-grid-container">
        <table className="table-grid">
          <thead>
            <tr>
              <th className="table-corner">
                {data.yLabel || 'Y'} / {data.xLabel || 'X'}
              </th>
              {data.xAxis.map((x, i) => (
                <th key={i} className="table-x-header">
                  {editingAxis?.axis === 'x' && editingAxis.index === i ? (
                    <input
                      type="text"
                      className="axis-header-input"
                      // A bare <input>'s browser-intrinsic min-width
                      // (~20 characters) survives CSS width/min-width
                      // overrides and visibly balloons whatever column it
                      // sits in - only the size attribute itself controls
                      // it. Axis bin values are always short.
                      size={4}
                      value={axisEditValue}
                      autoFocus
                      onChange={(e) => setAxisEditValue(e.target.value)}
                      onBlur={() => finishAxisEdit(true)}
                      onKeyDown={handleAxisKeyDown}
                      onFocus={(e) => e.target.select()}
                    />
                  ) : (
                    <span onClick={() => handleAxisClick('x', i)}>{formatValue(x)}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Display order only — rowIndex stays in data space */}
            {/* One timestamp per render: the fade refreshes when the trail
                tick (or any other state change) re-renders the grid. */}
            {(() => {
              const renderNow = Date.now();
              return (yAxisBottom ? [...data.yAxis.keys()].reverse() : [...data.yAxis.keys()]).map((rowIndex) => (
              <tr key={rowIndex}>
                <th className="table-y-header">
                  {editingAxis?.axis === 'y' && editingAxis.index === rowIndex ? (
                    <input
                      type="text"
                      className="axis-header-input"
                      // A bare <input>'s browser-intrinsic min-width
                      // (~20 characters) survives CSS width/min-width
                      // overrides and visibly balloons whatever column it
                      // sits in - only the size attribute itself controls
                      // it. Axis bin values are always short.
                      size={4}
                      value={axisEditValue}
                      autoFocus
                      onChange={(e) => setAxisEditValue(e.target.value)}
                      onBlur={() => finishAxisEdit(true)}
                      onKeyDown={handleAxisKeyDown}
                      onFocus={(e) => e.target.select()}
                    />
                  ) : (
                    <span onClick={() => handleAxisClick('y', rowIndex)}>{formatValue(data.yAxis[rowIndex])}</span>
                  )}
                </th>
                {data.xAxis.map((_, colIndex) => {
                  const value = data.zValues[rowIndex][colIndex];
                  const isSelected = isCellSelected(rowIndex, colIndex);
                  const isEditing = editingCell?.row === rowIndex && editingCell?.col === colIndex;
                  const isLive = effectiveLivePosition?.row === rowIndex && effectiveLivePosition?.col === colIndex;

                  // Check if cell is in trail and calculate opacity
                  const trailEntry = trailMap.get(`${rowIndex},${colIndex}`);
                  const trailOpacity = trailEntry ? Math.max(0, 1 - (renderNow - trailEntry.time) / TRAIL_DURATION_MS) : 0;
                  const isInTrail = trailOpacity > 0 && !isLive;

                  // One color computation per cell (previously two: the
                  // background and its contrast text each re-derived it).
                  const cellColor = getValueColor(value);

                  return (
                    <td
                      key={colIndex}
                      className={`table-cell ${isSelected ? 'selected' : ''} ${isLive ? 'live' : ''} ${isInTrail ? 'trail' : ''}`}
                      style={{
                        backgroundColor: cellColor,
                        color: contrastTextColor(cellColor),
                        ...(isInTrail && { '--trail-opacity': trailOpacity } as React.CSSProperties)
                      }}
                      onMouseDown={(e) => handleCellMouseDown(rowIndex, colIndex, e)}
                      onMouseEnter={() => handleCellMouseEnter(rowIndex, colIndex)}
                    >
                      {isEditing ? (
                        <input
                          ref={inputRef}
                          type="text"
                          className="table-cell-input"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={() => finishEdit(true)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              finishEdit(true);
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              finishEdit(false);
                            }
                          }}
                        />
                      ) : (
                        formatValue(value)
                      )}
                    </td>
                  );
                })}
              </tr>
              ));
            })()}
          </tbody>
        </table>
      </div>
      )}

      {/* Status */}
      <div className="table-status">
        <span>{data.name}</span>
        {selection && (
          <span>
            Selected: {getSelectedCells().length} cell(s)
          </span>
        )}
        {data.zUnits && <span>Units: {data.zUnits}</span>}
      </div>

      {generatableKind && (
        <GenerateTableDialog
          isOpen={showGenerateDialog}
          onClose={() => setShowGenerateDialog(false)}
          tableName={data.name}
          kind={generatableKind}
          rpmBins={data.xAxis}
          loadBins={data.yAxis}
          onApply={applyGeneratedValues}
        />
      )}
    </div>
  );
}


// Subcomponents extracted to ./table-editor/
export { default as TableToolbar } from './table-editor/TableToolbar';
export { default as TableContextMenu } from './table-editor/TableContextMenu';
