import { useEffect, useRef, useState } from "react";
import { pairOnServer, parseOnServer } from "./api";
import { formatSignedMs } from "./format";
import { parseSchedule } from "./parser";
import type {
  Cue,
  LineError,
  MatchResult,
  RecordedTap,
} from "./types";
import "./styles.css";

const SAMPLE_SCHEDULE = "开场灯光|0\n主角登场|3200\n第一段唱段|8000\n谢幕|16000";

export default function App() {
  const [draft, setDraft] = useState("");
  const [cues, setCues] = useState<Cue[] | null>(null);
  const [importErrors, setImportErrors] = useState<LineError[]>([]);
  const [importNote, setImportNote] = useState("");

  const [running, setRunning] = useState(false);
  const [taps, setTaps] = useState<RecordedTap[]>([]);
  const firstHitRef = useRef<number | null>(null);

  const [result, setResult] = useState<MatchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [remoteError, setRemoteError] = useState("");

  // Space-bar capture with the browser monotonic clock. Every tap is the
  // integer-ms distance from the first tap, so the first tap is always 0.
  useEffect(() => {
    if (!running) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      if (event.repeat) {
        return;
      }
      const now = performance.now();
      if (firstHitRef.current === null) {
        firstHitRef.current = now;
      }
      const timeMs = Math.round(now - firstHitRef.current);
      setTaps((previous) => [
        ...previous,
        { time_ms: timeMs, seq: previous.length },
      ]);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [running]);

  async function handleImport() {
    // Local mirror gives instant, line-located feedback. On any rejection we
    // return early without touching `cues` or the previous success note, so
    // an illegal import can never overwrite the last valid schedule.
    const local = parseSchedule(draft);
    if (!local.valid) {
      setImportErrors(local.errors);
      return;
    }

    try {
      const server = await parseOnServer(draft);
      if (!server.valid) {
        setImportErrors(server.errors);
        return;
      }
      setImportErrors([]);
      setCues(server.cues);
      setImportNote(`已导入 ${server.cues.length} 行计划。`);
      setResult(null);
      setTaps([]);
      firstHitRef.current = null;
    } catch (error) {
      setImportErrors([
        {
          line: 0,
          code: "EMPTY_DOCUMENT",
          message: `服务器校验失败，未覆盖现有计划：${(error as Error).message}`,
        },
      ]);
    }
  }

  function handleStart() {
    setRunning(true);
    setTaps([]);
    setResult(null);
    setRemoteError("");
    firstHitRef.current = null;
  }

  function handleStop() {
    setRunning(false);
  }

  function registerTap() {
    if (!running) {
      return;
    }
    const now = performance.now();
    if (firstHitRef.current === null) {
      firstHitRef.current = now;
    }
    const timeMs = Math.round(now - firstHitRef.current);
    setTaps((previous) => [
      ...previous,
      { time_ms: timeMs, seq: previous.length },
    ]);
  }

  async function handleSubmit() {
    if (!cues) {
      return;
    }
    setBusy(true);
    setRemoteError("");
    try {
      const matched = await pairOnServer(cues, taps);
      setResult(matched);
    } catch (error) {
      setRemoteError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const errorsByLine = new Map<number, LineError[]>();
  importErrors.forEach((error) => {
    const list = errorsByLine.get(error.line) ?? [];
    list.push(error);
    errorsByLine.set(error.line, list);
  });

  return (
    <main className="page">
      <h1>字幕对点台</h1>

      <section className="card" aria-label="计划导入">
        <h2>1. 导入计划时间表</h2>
        <p className="hint">每行格式：字幕文本|整数毫秒（时间严格递增、不得重复，不得为负）。</p>
        <textarea
          data-testid="schedule-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={"开场|0\n主角登场|3200"}
          rows={7}
        />
        <div className="row">
          <button type="button" data-testid="import-button" onClick={handleImport}>
            导入并校验
          </button>
          <button
            type="button"
            onClick={() => setDraft(SAMPLE_SCHEDULE)}
          >
            填入示例
          </button>
        </div>
        {importNote && (
          <p className="note" data-testid="import-note">
            {importNote}
          </p>
        )}
        {importErrors.length > 0 && (
          <div className="errors" data-testid="import-errors">
            {[...errorsByLine.entries()].map(([line, list]) => (
              <div key={`${line}-${list.map((e) => e.code).join(",")}`}>
                {line > 0 ? <strong>第 {line} 行：</strong> : null}
                {list.map((error) => error.message).join("；")}
              </div>
            ))}
          </div>
        )}
        {cues && (
          <table className="schedule" data-testid="schedule-table">
            <thead>
              <tr>
                <th>#</th>
                <th>字幕文本</th>
                <th>计划时间 (ms)</th>
              </tr>
            </thead>
            <tbody>
              {cues.map((cue, index) => (
                <tr key={index}>
                  <td>{index + 1}</td>
                  <td>{cue.text}</td>
                  <td>{cue.time_ms}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card" aria-label="联排">
        <h2>2. 联排敲击</h2>
        <div className="row">
          {!running ? (
            <button
              type="button"
              data-testid="start-button"
              onClick={handleStart}
              disabled={!cues}
            >
              开始联排
            </button>
          ) : (
            <button type="button" data-testid="stop-button" onClick={handleStop}>
              结束联排
            </button>
          )}
          <button
            type="button"
            data-testid="tap-button"
            onPointerDown={(event) => {
              event.preventDefault();
              registerTap();
            }}
            disabled={!running}
          >
            敲击（也可按空格）
          </button>
          <button
            type="button"
            data-testid="submit-button"
            onClick={handleSubmit}
            disabled={running || taps.length === 0 || busy || !cues}
          >
            {busy ? "提交中…" : "提交配对"}
          </button>
        </div>
        {running && <p className="hint">联排中：按空格键记录敲击，首击记为 0 ms。</p>}
        <ul className="taps" data-testid="tap-list">
          {taps.map((tap) => (
            <li key={tap.seq}>
              第 {tap.seq + 1} 击：相对首击 {tap.time_ms} ms
            </li>
          ))}
        </ul>
        {remoteError && (
          <p className="errors" data-testid="remote-error">
            {remoteError}
          </p>
        )}
      </section>

      {result && cues && (
        <section className="card" aria-label="对点结果">
          <h2>3. 对点结果</h2>
          <table data-testid="pairs-table">
            <thead>
              <tr>
                <th>计划行</th>
                <th>字幕文本</th>
                <th>计划时间</th>
                <th>敲击序号</th>
                <th>敲击时间</th>
                <th>偏差（敲击−计划）</th>
              </tr>
            </thead>
            <tbody>
              {result.pairs.map((pair) => (
                <tr key={pair.cue_index} data-testid="pair-row">
                  <td>{pair.cue_index + 1}</td>
                  <td>{pair.cue_text}</td>
                  <td>{pair.cue_time_ms} ms</td>
                  <td>第 {pair.tap_seq + 1} 击</td>
                  <td>{pair.tap_time_ms} ms</td>
                  <td data-testid="pair-deviation">
                    {formatSignedMs(pair.deviation_ms)}
                  </td>
                </tr>
              ))}
              {result.pairs.length === 0 && (
                <tr>
                  <td colSpan={6} className="hint">
                    没有任何敲击落在计划时间的 800 ms 范围内。
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <div className="columns">
            <div>
              <h3>未配对计划</h3>
              <ul data-testid="unpaired-cues">
                {result.unmatched_cue_indices.map((index) => (
                  <li key={index}>
                    第 {index + 1} 行：{cues[index].text}（{cues[index].time_ms} ms）
                  </li>
                ))}
                {result.unmatched_cue_indices.length === 0 && (
                  <li className="hint">无</li>
                )}
              </ul>
            </div>
            <div>
              <h3>未配对敲击</h3>
              <ul data-testid="unpaired-taps">
                {result.unmatched_tap_indices.map((index) => (
                  <li key={index}>
                    第 {taps[index].seq + 1} 击（{taps[index].time_ms} ms）
                  </li>
                ))}
                {result.unmatched_tap_indices.length === 0 && (
                  <li className="hint">无</li>
                )}
              </ul>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
