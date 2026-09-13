import { useEffect, useRef, useState } from "react";
import { pairOnServer, parseOnServer } from "./api";
import { formatSignedMs } from "./format";
import { parseSchedule } from "./parser";
import type {
  Cue,
  LineError,
  MatchResult,
  Pair,
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

  // Session epoch: every (re)start — and every successful re-import — opens a
  // new rehearsal session. A /api/match response (raw submit or anchor
  // recalibration) is applied only when the session it was issued for is still
  // active, so a late answer from a previous session can never repopulate the
  // current run's result page.
  const sessionRef = useRef(0);

  // Import epoch: every import attempt — including one that is about to be
  // refused locally or by the running-rehearsal guard — supersedes every
  // earlier attempt, and starting a rehearsal supersedes whatever import is
  // still in flight. A /api/parse response is applied only while its attempt
  // is the latest one, so a late answer can neither replace a newer plan with
  // an older one, nor wipe the active run's taps, nor overwrite the feedback
  // (success note or line errors) of the attempt currently on screen.
  const importSeqRef = useRef(0);

  const [result, setResult] = useState<MatchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [remoteError, setRemoteError] = useState("");
  const [anchorBusyCue, setAnchorBusyCue] = useState<number | null>(null);
  const [anchorError, setAnchorError] = useState("");

  // Space-bar capture with the browser monotonic clock. Every tap is the
  // integer-ms distance from the first tap, so the first tap is always 0.
  // Values are bigints end-to-end so arbitrarily large schedule times stay
  // exact (a double cannot distinguish adjacent values past 2^53).
  function elapsedSinceFirst(now: number): bigint {
    if (firstHitRef.current === null) {
      firstHitRef.current = now;
    }
    return BigInt(Math.round(now - firstHitRef.current));
  }

  useEffect(() => {
    if (!running) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" && event.key !== " ") {
        return;
      }
      // While the operator is editing the schedule text (or any other
      // field), Space must just type a space: never steal it for a tap and
      // never prevent the default text editing behaviour.
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "INPUT" ||
          target.tagName === "SELECT")
      ) {
        return;
      }
      event.preventDefault();
      if (event.repeat) {
        return;
      }
      const timeMs = elapsedSinceFirst(performance.now());
      setTaps((previous) => [
        ...previous,
        { time_ms: timeMs, seq: previous.length },
      ]);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [running]);

  async function handleImport() {
    // Supersede every earlier import request before anything else happens:
    // whatever feedback this attempt produces (refusal, line errors, success)
    // is the current state, and a late response from an older request must
    // never clear or overwrite it.
    const attempt = ++importSeqRef.current;
    // A rehearsal is active — even one that has just been started and has not
    // recorded a tap yet. Importing a new plan here would replace the cues and
    // reset the first-hit clock while the page still claims "联排中". Refuse
    // before anything changes; the operator must stop the run first.
    if (running) {
      setImportErrors([
        {
          line: 0,
          code: "REHEARSAL_IN_PROGRESS",
          message: `联排进行中（已记录 ${taps.length} 次敲击）：请先结束联排再重新导入计划，本次操作未改动活动场次与已记录的敲击。`,
        },
      ]);
      return;
    }
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
      if (importSeqRef.current !== attempt) {
        // A newer import attempt — or a freshly started rehearsal — has
        // superseded this request while the server was answering. Drop the
        // late response untouched: applying it would replace the plan the
        // operator has already moved on from (and clear the active run's
        // taps) or erase the newer attempt's own feedback.
        return;
      }
      if (!server.valid) {
        setImportErrors(server.errors);
        return;
      }
      setImportErrors([]);
      // A fresh plan opens a new session: any match response still in flight
      // for the previous plan belongs to a dead session and must be dropped.
      sessionRef.current += 1;
      setCues(server.cues);
      setImportNote(`已导入 ${server.cues.length} 行计划。`);
      setResult(null);
      setTaps([]);
      setBusy(false);
      setAnchorBusyCue(null);
      firstHitRef.current = null;
      setAnchorError("");
    } catch (error) {
      if (importSeqRef.current !== attempt) {
        // Stale failure: a newer attempt already owns the import area (its
        // plan may have been imported successfully), so this old error must
        // not appear next to it.
        return;
      }
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
    // New rehearsal session: the increment invalidates every match response
    // (raw submission or anchor recalibration) still in flight for a previous
    // session, so a late answer cannot repopulate this run's empty result.
    sessionRef.current += 1;
    // A run starting also retires any import still in flight: its late
    // response would otherwise replace the plan and wipe this run's taps.
    importSeqRef.current += 1;
    setRunning(true);
    setTaps([]);
    setResult(null);
    setBusy(false);
    setAnchorBusyCue(null);
    setRemoteError("");
    setAnchorError("");
    firstHitRef.current = null;
  }

  function handleStop() {
    setRunning(false);
  }

  function registerTap() {
    if (!running) {
      return;
    }
    const timeMs = elapsedSinceFirst(performance.now());
    setTaps((previous) => [
      ...previous,
      { time_ms: timeMs, seq: previous.length },
    ]);
  }

  async function handleSubmit() {
    if (!cues) {
      return;
    }
    // Pin the response to the session that issued it; if the operator starts
    // a new run before the answer returns, it must be discarded.
    const session = sessionRef.current;
    setBusy(true);
    setRemoteError("");
    setAnchorError("");
    try {
      const matched = await pairOnServer(cues, taps);
      if (sessionRef.current !== session) {
        return;
      }
      setResult(matched);
    } catch (error) {
      if (sessionRef.current !== session) {
        return;
      }
      setRemoteError((error as Error).message);
    } finally {
      if (sessionRef.current === session) {
        setBusy(false);
      }
    }
  }

  async function handleSetAnchor(pair: Pair) {
    if (!cues || anchorBusyCue !== null) {
      return;
    }
    const session = sessionRef.current;
    // On any rejection keep the current result exactly as it was and explain
    // the reason next to the operation; only a successful calibration swaps
    // the table. A recalibration whose session has since ended (operator moved
    // on to a new run) is dropped, including its late error and spinner.
    setAnchorBusyCue(pair.cue_index);
    setAnchorError("");
    try {
      const recalibrated = await pairOnServer(cues, taps, [
        { cue_index: pair.cue_index, tap_index: pair.tap_index },
      ]);
      if (sessionRef.current !== session) {
        return;
      }
      setResult(recalibrated);
    } catch (error) {
      if (sessionRef.current !== session) {
        return;
      }
      setAnchorError((error as Error).message);
    } finally {
      if (sessionRef.current === session) {
        setAnchorBusyCue(null);
      }
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
                  <td>{cue.time_ms.toString()}</td>
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
              第 {tap.seq + 1} 击：相对首击 {tap.time_ms.toString()} ms
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
          {result.calibrated && (
            <p className="note" data-testid="calibration-note">
              已按校准锚点（第 {(result.anchor_cue_index ?? 0) + 1}{" "}
              行计划）重新对点：全场校准量{" "}
              {formatSignedMs(result.offset_ms ?? 0n)}
              （锚点原始敲击−计划时间；其余敲击已整体减去该量）。锚点行校准后偏差为{" "}
              {formatSignedMs(0n)}。
            </p>
          )}
          <table data-testid="pairs-table">
            <thead>
              <tr>
                <th>计划行</th>
                <th>字幕文本</th>
                <th>计划时间</th>
                <th>敲击序号</th>
                <th>敲击时间</th>
                <th>偏差（敲击−计划）</th>
                {result.calibrated && <th>校准后敲击时间</th>}
                {result.calibrated && <th>校准后偏差</th>}
                <th>校准操作</th>
              </tr>
            </thead>
            <tbody>
              {result.pairs.map((pair) => {
                const isAnchor =
                  result.calibrated &&
                  pair.cue_index === result.anchor_cue_index &&
                  pair.tap_index === result.anchor_tap_index;
                return (
                  <tr
                    key={pair.cue_index}
                    data-testid="pair-row"
                    className={isAnchor ? "anchor-row" : undefined}
                  >
                    <td>{pair.cue_index + 1}</td>
                    <td>{pair.cue_text}</td>
                    <td>{pair.cue_time_ms.toString()} ms</td>
                    <td>第 {pair.tap_seq + 1} 击</td>
                    <td>{pair.tap_time_ms.toString()} ms</td>
                    <td data-testid="pair-deviation">
                      {formatSignedMs(pair.deviation_ms)}
                    </td>
                    {result.calibrated && (
                      <td data-testid="pair-calibrated-time">
                        {(pair.calibrated_tap_time_ms ?? 0n).toString()} ms
                      </td>
                    )}
                    {result.calibrated && (
                      <td data-testid="pair-calibrated-deviation">
                        {formatSignedMs(pair.calibrated_deviation_ms ?? 0n)}
                      </td>
                    )}
                    <td>
                      {result.calibrated ? (
                        isAnchor ? (
                          <span
                            className="anchor-badge"
                            data-testid="anchor-badge"
                          >
                            校准锚点（锁定）
                          </span>
                        ) : (
                          <span className="hint">已按锚点重算</span>
                        )
                      ) : (
                        <button
                          type="button"
                          data-testid="set-anchor-button"
                          onClick={() => handleSetAnchor(pair)}
                          disabled={anchorBusyCue !== null}
                        >
                          {anchorBusyCue === pair.cue_index
                            ? "校准中…"
                            : "设为校准锚点"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {result.pairs.length === 0 && (
                <tr>
                  <td colSpan={result.calibrated ? 9 : 7} className="hint">
                    没有任何敲击落在计划时间的 800 ms 范围内。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {anchorError && (
            <p className="errors" data-testid="anchor-error">
              {anchorError}
            </p>
          )}
          {!result.calibrated && (
            <p className="hint">
              若全场敲击相对计划存在稳定起步偏移，可任选一行已配对行作为校准锚点，
              服务端将锁定该锚点，按其原始偏差平移全场敲击后重新对点。
            </p>
          )}

          <div className="columns">
            <div>
              <h3>未配对计划</h3>
              <ul data-testid="unpaired-cues">
                {result.unmatched_cue_indices.map((index) => (
                  <li key={index}>
                    第 {index + 1} 行：{cues[index].text}（
                    {cues[index].time_ms.toString()} ms）
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
                    第 {taps[index].seq + 1} 击（{taps[index].time_ms.toString()} ms）
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
