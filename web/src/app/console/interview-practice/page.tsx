"use client";

/* Phase 11 (v2 plan) — AI interview/FGD/LGD practice: a dedicated
 * voice-based session, reachable from the sidebar, the Dashboard's own
 * card, and a deep link from the Assistant's start_interview_practice
 * tool card (`?session_id=...`). One turn is one HTTP request — see
 * interview_service.py's own module docstring for why this is
 * intentionally coarser than the Assistant/Pipeline's own streaming
 * loops.
 *
 * Live session UI redesigned around a real call, per Adrian: your own
 * camera on the left (a local self-view only — never uploaded,
 * recorded, or analyzed, purely so you can see yourself while
 * practicing), a radial audio visualizer on the right that changes
 * color for listening/thinking/speaking, and a mic mute/unmute toggle
 * instead of a manual record/stop button — while unmuted, a client-
 * side voice-activity detector listens for you to start and stop
 * talking and submits each utterance as its own turn automatically.
 * The turn-by-turn chat log still exists (TranscriptView) but is now a
 * secondary, collapsed-by-default record of the session, not the main
 * UI.
 *
 * FGD/LGD's multi-speaker reply (Moderator + exactly one Discussant,
 * per Adrian) is split into one transcript bubble per speaker (see
 * splitAgentReply below) and synthesized with a distinct voice per
 * role server-side (interview_service.py's own per-segment TTS) —
 * still stored/replayed as ONE combined clip for the whole turn,
 * though, so the ▶ replay button lives on only the last bubble.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  api,
  INTERVIEW_CATEGORIES,
  INTERVIEW_CATEGORY_LABEL,
  INTERVIEW_PRACTICE_TYPES,
  INTERVIEW_PRACTICE_TYPE_LABEL,
  type InboxJob,
  type InterviewCategory,
  type InterviewPracticeType,
  type InterviewSession,
  type InterviewTurnEvent,
} from "@/lib/api";
import { usePersona } from "@/components/persona-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Loader2, Mic, MicOff, Trash2, Video, VideoOff, Volume2 } from "lucide-react";

const SENIORITY_OPTIONS = ["intern", "junior", "mid", "senior", "lead", "staff", "principal"];

type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string; speaker: string | null; audioFilename?: string };

// Mirrors interview_service.py's own _split_speaker_segments exactly
// (same "Speaker: text" line format, same continuation-line handling)
// so the transcript's bubbles line up 1:1 with what was actually
// synthesized/spoken per segment — plain interview mode is always a
// single, unlabeled segment.
const SPEAKER_LINE_RE = /^([^:]{1,40}):\s(.*)$/;

function splitAgentReply(
  text: string,
  practiceType: InterviewPracticeType,
): { speaker: string | null; text: string }[] {
  if (practiceType === "interview") return [{ speaker: null, text }];
  const segments: { speaker: string | null; text: string }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = SPEAKER_LINE_RE.exec(line);
    if (m) {
      segments.push({ speaker: m[1].trim(), text: m[2].trim() });
    } else if (segments.length > 0) {
      segments[segments.length - 1].text += ` ${line}`;
    } else {
      segments.push({ speaker: null, text: line });
    }
  }
  return segments.length > 0 ? segments : [{ speaker: null, text }];
}

// "starting" — the opening turn is being generated (the model reads
// the role/persona context, which can genuinely take a while) — shown
// INSTEAD of the full camera+visualizer UI until it's actually ready
// to talk (raised directly by Adrian). Reached both right after
// creating a session and when reopening one whose opening turn never
// finished (no persisted "done" event yet) — see openSession, which
// re-derives this from real server state every time, so it shows
// correctly even after navigating away and back, not just within one
// browser tab's own memory.
// "ending" — scoring/feedback is running, whether from the human
// clicking "End session" or the agent's own end_interview tool.
type Phase = "list" | "new" | "starting" | "session" | "ending" | "results" | "loading";

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ?? null;
}

// --- The radial audio visualizer (raised directly by Adrian: not
// just a text status indicator, a real amplitude-reactive visualizer
// that also switches color for listening/thinking/speaking) ---

type VisualizerState = "idle" | "listening" | "thinking" | "speaking";

const VISUALIZER_COLOR: Record<VisualizerState, string> = {
  idle: "#9ca3af", // gray-400 — mic muted, nothing happening
  listening: "#3b82f6", // blue-500 — your turn, mic live
  thinking: "#f59e0b", // amber-500 — the agent is processing, no audio yet
  speaking: "#22c55e", // green-500 — the agent's reply is playing
};

const VISUALIZER_LABEL: Record<VisualizerState, string> = {
  idle: "Muted",
  listening: "Your turn",
  thinking: "Thinking…",
  speaking: "Speaking…",
};

function AudioVisualizer({
  state,
  analyser,
  size = 240,
}: {
  state: VisualizerState;
  analyser: AnalyserNode | null;
  size?: number;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const ctx2d = canvas?.getContext("2d");
    if (!canvas || !ctx2d) return;

    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx2d.scale(dpr, dpr);

    const barCount = 40;
    const freqData = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;
    const color = VISUALIZER_COLOR[state];
    // Real amplitude data only makes sense for listening/speaking
    // (an actual mic or playback signal exists then) — "thinking"/
    // "idle" get a slow synthetic breathing animation instead of
    // reading stale/empty analyser data.
    const useRealData = analyser && freqData && (state === "listening" || state === "speaking");
    let rafId = 0;
    let t = 0;

    const draw = () => {
      t += 1;
      ctx2d.clearRect(0, 0, size, size);
      const cx = size / 2;
      const cy = size / 2;
      const baseRadius = size * 0.26;
      if (useRealData) analyser!.getByteFrequencyData(freqData!);
      for (let i = 0; i < barCount; i++) {
        const angle = (i / barCount) * Math.PI * 2 - Math.PI / 2;
        const amp = useRealData
          ? freqData![Math.floor((i / barCount) * freqData!.length)] / 255
          : 0.12 + 0.08 * Math.sin(t / 14 + i * 0.35);
        const barLen = 5 + amp * baseRadius * 0.75;
        const x1 = cx + Math.cos(angle) * baseRadius;
        const y1 = cy + Math.sin(angle) * baseRadius;
        const x2 = cx + Math.cos(angle) * (baseRadius + barLen);
        const y2 = cy + Math.sin(angle) * (baseRadius + barLen);
        ctx2d.strokeStyle = color;
        ctx2d.lineWidth = 3;
        ctx2d.lineCap = "round";
        ctx2d.beginPath();
        ctx2d.moveTo(x1, y1);
        ctx2d.lineTo(x2, y2);
        ctx2d.stroke();
      }
      rafId = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(rafId);
  }, [state, analyser, size]);

  return <canvas ref={canvasRef} style={{ width: size, height: size }} className="mx-auto" />;
}

function buildTranscriptFromEvents(
  events: { type: InterviewTurnEvent["type"]; data: Record<string, unknown> }[],
  practiceType: InterviewPracticeType,
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const e of events) {
    if (e.type === "message" && e.data.role === "user") {
      items.push({ kind: "user", text: String(e.data.text ?? "") });
    } else if (e.type === "done") {
      const replyText = String(e.data.reply_text ?? "");
      const audioFilename = e.data.audio_filename ? String(e.data.audio_filename) : undefined;
      // One bubble per speaker segment (Moderator / Discussant get
      // their own bubbles, per Adrian) — the replay link only needs to
      // live on one of them since it's a single combined clip for the
      // whole turn, so it's attached to the last segment.
      const segments = splitAgentReply(replyText, practiceType);
      segments.forEach((seg, i) => {
        items.push({
          kind: "agent",
          text: seg.text,
          speaker: seg.speaker,
          audioFilename: i === segments.length - 1 ? audioFilename : undefined,
        });
      });
    }
  }
  return items;
}

function TranscriptView({
  items,
  running,
  stageMessage,
  onReplay,
}: {
  items: TranscriptItem[];
  running: boolean;
  stageMessage: string | null;
  onReplay: (filename: string) => void;
}) {
  const bottomRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [items, running]);

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-background p-3 max-h-[50vh] overflow-y-auto">
      {items.map((item, i) => (
        <div key={i} className={cn("flex", item.kind === "user" ? "justify-end" : "justify-start")}>
          <div
            className={cn(
              "max-w-[85%] rounded-lg px-3 py-2 text-xs",
              item.kind === "user"
                ? "rounded-tr-none bg-primary text-primary-foreground whitespace-pre-wrap"
                : "rounded-tl-none bg-secondary",
            )}
          >
            {item.kind === "agent" ? (
              <>
                {item.speaker && (
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
                    {item.speaker}
                  </div>
                )}
                <div className="whitespace-pre-wrap">{item.text}</div>
                {item.audioFilename && (
                  <button
                    type="button"
                    className="mt-1.5 text-[10px] text-primary underline underline-offset-2"
                    onClick={() => onReplay(item.audioFilename!)}
                  >
                    ▶ replay audio
                  </button>
                )}
              </>
            ) : (
              item.text
            )}
          </div>
        </div>
      ))}
      {running && (
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground">
          <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.3s]" />
          <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.15s]" />
          <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce" />
          {stageMessage && <span>{stageMessage}</span>}
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

// Voice-activity detection thresholds — plain RMS off the mic's own
// time-domain samples, no ML model. Deliberately simple: this is a
// practice tool on a device with normal room acoustics, not a
// production call product; tuned by feel against a real mic rather
// than derived from anything.
const VAD_SPEECH_RMS = 0.02;
const VAD_SILENCE_RMS = 0.012;
// How long of real silence before an utterance is considered finished
// and submitted. The loop below (see startVadLoop) already resets
// this countdown the instant it hears ANY renewed sound above
// VAD_SILENCE_RMS — so a person pausing mid-thought and then
// continuing never gets cut off, as long as the pause itself is
// shorter than this. 900ms (this value before Adrian's own report of
// getting interrupted mid-pause) was simply too tight for how people
// actually pause while composing an answer, especially under mock-
// interview nerves — a real spoken pause is very often 1-2s. Raised
// to a more forgiving 1.6s; still short enough that the interviewer
// doesn't feel sluggish to respond once you're actually done talking.
const VAD_SILENCE_HOLD_MS = 1600;
const VAD_MIN_UTTERANCE_MS = 300;

export default function InterviewPracticePage() {
  const router = useRouter();
  const { selectedPersonaId } = usePersona();

  const [phase, setPhase] = React.useState<Phase>("list");
  const [sessions, setSessions] = React.useState<InterviewSession[]>([]);
  const [loadingList, setLoadingList] = React.useState(true);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null);
  const [session, setSession] = React.useState<InterviewSession | null>(null);
  const [activePracticeType, setActivePracticeType] = React.useState<InterviewPracticeType>("interview");
  const [transcript, setTranscript] = React.useState<TranscriptItem[]>([]);
  const [running, setRunning] = React.useState(false);
  const [stageMessage, setStageMessage] = React.useState<string | null>(null);
  const [audioUrl, setAudioUrl] = React.useState<string | null>(null);
  // Whether this TURN (not this segment) has started playing audio
  // yet — gates whether handleAudioStreamStart resets the gapless-
  // scheduling cursor: FGD/LGD synthesizes several speaker segments
  // per turn, each getting its own audio_start, and only the FIRST
  // one should reset the schedule — later ones need to queue up
  // right after whatever's already scheduled, not restart at "now".
  const turnHasAudioRef = React.useRef(false);
  // Which of the two FGD/LGD voices is CURRENTLY playing — null in
  // plain interview mode (only one visualizer exists there) and
  // between turns.
  const [currentSpeakerRole, setCurrentSpeakerRole] = React.useState<"moderator" | "discusser" | null>(null);
  const activeSessionIdRef = React.useRef<string | null>(null);
  const runningRef = React.useRef(false);
  React.useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);
  React.useEffect(() => {
    runningRef.current = running;
  }, [running]);

  // The blob: URL currently backing `audioUrl` — tracked separately so
  // it can be revoked the moment a new turn's audio replaces it
  // (URL.createObjectURL leaks memory otherwise), and on unmount. Used
  // only for the ▶ replay button (an already-stored past turn) — the
  // live turn plays through the PCM streaming engine further down.
  const audioBlobUrlRef = React.useRef<string | null>(null);

  const loadAudio = React.useCallback(async (sessionId: string, filename: string) => {
    try {
      const blob = await api.fetchInterviewAudio(sessionId, filename);
      const url = URL.createObjectURL(blob);
      if (audioBlobUrlRef.current) URL.revokeObjectURL(audioBlobUrlRef.current);
      audioBlobUrlRef.current = url;
      setAudioUrl(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load this turn's audio");
    }
  }, []);

  React.useEffect(() => {
    return () => {
      if (audioBlobUrlRef.current) URL.revokeObjectURL(audioBlobUrlRef.current);
    };
  }, []);

  // --- New-session form state ---
  const [practiceType, setPracticeType] = React.useState<InterviewPracticeType>("interview");
  const [category, setCategory] = React.useState<InterviewCategory | "">("");
  const [seniority, setSeniority] = React.useState("");
  const [targetMode, setTargetMode] = React.useState<"job" | "manual">("job");
  const [jobId, setJobId] = React.useState<string | null>(null);
  const [jobSearch, setJobSearch] = React.useState("");
  const [jobs, setJobs] = React.useState<InboxJob[]>([]);
  const [loadingJobs, setLoadingJobs] = React.useState(false);
  const [roleTitle, setRoleTitle] = React.useState("");
  const [companyName, setCompanyName] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  const refreshList = React.useCallback(async () => {
    if (!selectedPersonaId) {
      setSessions([]);
      setLoadingList(false);
      return;
    }
    setLoadingList(true);
    try {
      setSessions(await api.listInterviewSessions(selectedPersonaId));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load sessions");
    } finally {
      setLoadingList(false);
    }
  }, [selectedPersonaId]);

  async function handleDeleteSession(s: InterviewSession, e?: React.MouseEvent) {
    e?.stopPropagation();
    const label = [s.role_title, s.company_name].filter(Boolean).join(" @ ") || INTERVIEW_PRACTICE_TYPE_LABEL[s.practice_type];
    if (!window.confirm(`Delete this practice session (${label})? This also deletes its transcript and audio — can't be undone.`)) {
      return;
    }
    setDeletingId(s.id);
    try {
      await api.deleteInterviewSession(s.id);
      setSessions((prev) => prev.filter((x) => x.id !== s.id));
      toast.success("Practice session deleted");
      // Deleted the one currently open (e.g. from the results screen)
      // — nothing left to show, so head back to the list.
      if (activeSessionId === s.id) backToList();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete session");
    } finally {
      setDeletingId(null);
    }
  }

  React.useEffect(() => {
    (async () => {
      await refreshList();
    })();
  }, [refreshList]);

  React.useEffect(() => {
    if (targetMode !== "job" || !selectedPersonaId) return;
    let cancelled = false;
    (() => setLoadingJobs(true))();
    (async () => {
      try {
        const list = await api.listInboxJobs(selectedPersonaId, {
          search: jobSearch || undefined,
          sort: "recommended",
          limit: 20,
        });
        if (!cancelled) setJobs(list);
      } catch (e) {
        if (!cancelled) toast.error(e instanceof Error ? e.message : "Failed to load jobs");
      } finally {
        if (!cancelled) setLoadingJobs(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [targetMode, selectedPersonaId, jobSearch]);

  async function consumeTurn(sessionId: string, gen: AsyncGenerator<InterviewTurnEvent>) {
    setRunning(true);
    setStageMessage(null);
    turnHasAudioRef.current = false;
    setCurrentSpeakerRole(null);
    try {
      for await (const evt of gen) {
        if (evt.type === "stage") {
          setStageMessage(evt.message);
          // The interviewer's own end_interview tool (or the human's
          // "End session" button) both funnel through the same
          // "scoring" stage — show the dedicated loading screen for
          // it either way, not just the inline transcript-log dots.
          if (evt.stage === "scoring") setPhase("ending");
        } else if (evt.type === "message") {
          setTranscript((prev) => [...prev, { kind: "user", text: evt.text }]);
        } else if (evt.type === "audio_start") {
          // The opening turn's reply is fully generated and about to
          // become audible right here — flip off the "starting" loading
          // screen at this exact moment, not after the whole turn (incl.
          // streaming playback) finishes, or the user hears the agent
          // talking underneath a loading screen that hasn't caught up yet.
          setPhase((p) => (p === "starting" ? "session" : p));
          handleAudioStreamStart(evt.sample_rate, evt.channels, evt.role);
        } else if (evt.type === "audio_chunk") {
          playPcmChunk(evt.data);
        } else if (evt.type === "audio_end") {
          // Per-SPEAKER-SEGMENT marker only (FGD/LGD has several per
          // turn) — the visualizer/isPlaying transition happens once
          // for the whole TURN, on "done" below, not per segment.
        } else if (evt.type === "done") {
          // No loadAudio() here — this turn's reply already played
          // live via the PCM stream above as it arrived. audio_filename
          // is kept only so the ▶ replay button can fetch it again
          // later (results screen, or reopening this session). One
          // bubble per speaker segment (Moderator/Discussant each get
          // their own, per Adrian) — the replay link goes on the last
          // one since it's a single combined clip for the whole turn.
          const segments = splitAgentReply(evt.reply_text, activePracticeType);
          setTranscript((prev) => [
            ...prev,
            ...segments.map((seg, i) => ({
              kind: "agent" as const,
              text: seg.text,
              speaker: seg.speaker,
              audioFilename: i === segments.length - 1 ? (evt.audio_filename ?? undefined) : undefined,
            })),
          ]);
          settleAudioAfterTurn();
        } else if (evt.type === "session_ended") {
          // The agent's own end_interview tool decided to end the
          // session — same result shape endInterviewSession's own
          // manual REST call returns, merged into the session state
          // already held (role_title/company_name/etc. aren't part of
          // this event, only what actually changed).
          stopAllMedia();
          setSession((prev) =>
            prev
              ? {
                  ...prev,
                  status: evt.status as InterviewSession["status"],
                  overall_score: evt.overall_score,
                  feedback: evt.feedback,
                  ended_at: evt.ended_at,
                }
              : prev,
          );
          setPhase("results");
          void refreshList();
        } else if (evt.type === "error") {
          toast.error(evt.message);
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That turn failed");
    } finally {
      setRunning(false);
      setStageMessage(null);
      // Safety net: if scoring was attempted (phase flipped to
      // "ending" above) but failed before a session_ended event ever
      // arrived (_end_session_after_turn's own error path), don't
      // strand the user on a permanent loading screen — the "error"
      // toast above already explains why.
      setPhase((p) => (p === "ending" ? "session" : p));
    }
  }

  async function openSession(sessionId: string) {
    setPhase("loading");
    setActiveSessionId(sessionId);
    setTranscript([]);
    setAudioUrl(null);
    router.replace(`/console/interview-practice?session_id=${sessionId}`, { scroll: false });
    try {
      const s = await api.getInterviewSession(sessionId);
      setSession(s);
      setActivePracticeType(s.practice_type);
      const { events } = await api.getInterviewSessionEvents(sessionId);
      const items = buildTranscriptFromEvents(events, s.practice_type);
      setTranscript(items);
      if (s.status !== "in_progress") {
        setPhase("results");
        return;
      }
      if (items.length === 0) {
        // No completed opening turn yet — either created via the
        // Assistant's start_interview_practice tool (a synchronous
        // tool call, it can't stream the opening turn itself, so it
        // only created the row) or a previous attempt was abandoned
        // mid-generation (the tab closed/navigated away — the turn
        // does NOT keep running server-side once nothing's reading its
        // stream, a real, disclosed simplification). Either way this
        // is exactly the "still thinking" state — show the loading
        // screen and (re)start it now, never the full camera UI before
        // there's an actual question to react to.
        setPhase("starting");
        await consumeTurn(sessionId, api.startInterviewSession(sessionId));
        setPhase((p) => (p === "starting" ? "session" : p));
      } else {
        setPhase("session");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load this session");
      setPhase("list");
    }
  }

  // Deep-link support — the Assistant's card and the Dashboard/list's
  // own row links land here with ?session_id=..., read the same
  // window.location.search way pipeline/page.tsx does (avoids
  // useSearchParams()'s Suspense-boundary requirement for a plain
  // client page like this one).
  const openedFromUrlRef = React.useRef(false);
  React.useEffect(() => {
    if (openedFromUrlRef.current) return;
    openedFromUrlRef.current = true;
    const sessionId = new URLSearchParams(window.location.search).get("session_id");
    (() => {
      if (sessionId) void openSession(sessionId);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleTargetModeChange(mode: "job" | "manual") {
    setTargetMode(mode);
    if (mode === "manual") setJobId(null);
  }

  async function handleCreateSession() {
    if (!selectedPersonaId) return;
    const usingJob = targetMode === "job" && !!jobId;
    if (!usingJob && !roleTitle.trim() && !companyName.trim()) {
      toast.error("Pick a job, or enter a role and/or company to target this session");
      return;
    }
    setCreating(true);
    try {
      const selectedJob = usingJob ? jobs.find((j) => j.id === jobId) : undefined;
      const { sessionId, events } = await api.createInterviewSession({
        persona_id: selectedPersonaId,
        job_id: usingJob ? (jobId as string) : undefined,
        role_title: usingJob ? undefined : roleTitle.trim() || undefined,
        company_name: usingJob ? undefined : companyName.trim() || undefined,
        seniority: seniority || undefined,
        practice_type: practiceType,
        category: practiceType === "interview" && category ? category : undefined,
      });
      setActiveSessionId(sessionId);
      setActivePracticeType(practiceType);
      // Optimistic, not fetched — the mic toggle below is gated on
      // `session?.status === "in_progress"`, and every field needed
      // for that (plus the header line) is already known client-side
      // right now. Waiting on a real GET here left the toggle
      // disabled for the entire opening turn — hit live, looked
      // exactly like the mic silently not working. The real fetch
      // below still runs after the turn completes, so anything this
      // guess got wrong (e.g. a denormalized role_title/company_name
      // from a job lookup) self-corrects a moment later.
      setSession({
        id: sessionId,
        persona_id: selectedPersonaId,
        job_id: usingJob ? (jobId as string) : null,
        application_id: null,
        role_title: usingJob ? (selectedJob?.title ?? null) : roleTitle.trim() || null,
        company_name: usingJob ? (selectedJob?.company_name_raw ?? null) : companyName.trim() || null,
        seniority: seniority || null,
        practice_type: practiceType,
        category: practiceType === "interview" && category ? category : null,
        status: "in_progress",
        overall_score: null,
        feedback: null,
        created_at: new Date().toISOString(),
        ended_at: null,
      });
      setTranscript([]);
      setAudioUrl(null);
      // Loading screen, not the full camera/visualizer UI, until the
      // opening turn actually finishes — reading the role and profile
      // context genuinely takes a while (raised directly by Adrian).
      setPhase("starting");
      router.replace(`/console/interview-practice?session_id=${sessionId}`, { scroll: false });
      await consumeTurn(sessionId, events);
      setSession(await api.getInterviewSession(sessionId));
      setPhase((p) => (p === "starting" ? "session" : p));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start session");
      setPhase("new");
    } finally {
      setCreating(false);
    }
  }

  async function handleEndSession() {
    if (!activeSessionId) return;
    if (!window.confirm("End this practice session now? You'll get your score and feedback right after.")) {
      return;
    }
    stopAllMedia();
    setPhase("ending");
    try {
      const updated = await api.endInterviewSession(activeSessionId);
      setSession(updated);
      setPhase("results");
      await refreshList();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to end session");
      setPhase("session");
    }
  }

  function handleReplay(filename: string) {
    if (!activeSessionId) return;
    void loadAudio(activeSessionId, filename);
  }

  function backToList() {
    stopAllMedia();
    setPhase("list");
    setActiveSessionId(null);
    setSession(null);
    router.replace("/console/interview-practice", { scroll: false });
    void refreshList();
  }

  function startNewFromScratch() {
    stopAllMedia();
    setPracticeType("interview");
    setCategory("");
    setSeniority("");
    setTargetMode("job");
    setJobId(null);
    setJobSearch("");
    setRoleTitle("");
    setCompanyName("");
    router.replace("/console/interview-practice", { scroll: false });
    setPhase("new");
  }

  // --- Camera (self-view only — never recorded, uploaded, or
  // analyzed; purely so you can see yourself while practicing, same
  // as any real video call) ---
  const cameraStreamRef = React.useRef<MediaStream | null>(null);
  const cameraVideoRef = React.useRef<HTMLVideoElement | null>(null);
  const [cameraOn, setCameraOn] = React.useState(false);

  function stopCamera() {
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
    cameraStreamRef.current = null;
    if (cameraVideoRef.current) cameraVideoRef.current.srcObject = null;
    setCameraOn(false);
  }

  async function toggleCamera() {
    if (cameraOn) {
      stopCamera();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error("Camera access needs HTTPS (or localhost) — this page isn't loaded over a secure connection");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      cameraStreamRef.current = stream;
      if (cameraVideoRef.current) cameraVideoRef.current.srcObject = stream;
      setCameraOn(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Camera access was denied");
    }
  }

  // --- Mic (mute/unmute) + voice-activity detection — replaces the
  // old manual record/stop button per Adrian: while unmuted, speaking
  // is detected automatically (an amplitude rise, sustained, followed
  // by ~900ms of quiet) and the resulting utterance is submitted as
  // the next turn on its own, no click needed. Disabled — mic stream
  // stays open (still visually "on"), but the detector doesn't ACT on
  // it — for the whole span the agent is thinking or speaking
  // (`running`), both to avoid overlapping submissions and to avoid
  // ever picking up the agent's own voice through the speakers as if
  // it were the candidate talking. */
  const micStreamRef = React.useRef<MediaStream | null>(null);
  const micVadCtxRef = React.useRef<AudioContext | null>(null);
  const micVadAnalyserRef = React.useRef<AnalyserNode | null>(null);
  const micOnRef = React.useRef(false);
  const vadRafRef = React.useRef<number | null>(null);
  const vadStateRef = React.useRef<"idle" | "speaking">("idle");
  const utteranceRecorderRef = React.useRef<MediaRecorder | null>(null);
  const utteranceChunksRef = React.useRef<Blob[]>([]);
  const [micOn, setMicOn] = React.useState(false);
  const [vadListening, setVadListening] = React.useState(false);
  // Mirrors of the *Ref caches below, updated only at the handful of
  // moments an analyser is actually (re)created — render must never
  // read a ref's .current directly, so the visualizer's `analyser`
  // prop is derived from these, not from the refs.
  const [micAnalyserState, setMicAnalyserState] = React.useState<AnalyserNode | null>(null);
  const [pcmAnalyserState, setPcmAnalyserState] = React.useState<AnalyserNode | null>(null);
  const [replayAnalyserState, setReplayAnalyserState] = React.useState<AnalyserNode | null>(null);

  function beginUtterance() {
    const stream = micStreamRef.current;
    if (!stream || typeof MediaRecorder === "undefined") return;
    utteranceChunksRef.current = [];
    const mr = new MediaRecorder(stream);
    mr.ondataavailable = (e) => {
      if (e.data.size > 0) utteranceChunksRef.current.push(e.data);
    };
    mr.start();
    utteranceRecorderRef.current = mr;
    setVadListening(true);
  }

  function discardUtterance() {
    if (utteranceRecorderRef.current) {
      utteranceRecorderRef.current.ondataavailable = null;
      try {
        utteranceRecorderRef.current.stop();
      } catch {
        // already stopped/inactive — nothing to clean up
      }
    }
    utteranceRecorderRef.current = null;
    utteranceChunksRef.current = [];
    setVadListening(false);
  }

  async function finishUtteranceAndSubmit() {
    const mr = utteranceRecorderRef.current;
    const sessionId = activeSessionIdRef.current;
    setVadListening(false);
    if (!mr || !sessionId) return;
    const blob = await new Promise<Blob>((resolve) => {
      mr.onstop = () => resolve(new Blob(utteranceChunksRef.current, { type: mr.mimeType || "audio/webm" }));
      mr.stop();
    });
    utteranceRecorderRef.current = null;
    if (blob.size === 0) return;
    await consumeTurn(sessionId, api.submitInterviewTurn(sessionId, blob));
  }

  function startVadLoop() {
    const analyser = micVadAnalyserRef.current;
    if (!analyser) return;
    const buffer = new Float32Array(analyser.fftSize);
    let lastAboveAt = performance.now();
    let speechStartAt = 0;

    const tick = () => {
      vadRafRef.current = requestAnimationFrame(tick);
      if (!micOnRef.current) return;
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
      const rms = Math.sqrt(sum / buffer.length);

      if (runningRef.current) {
        // The agent's turn — don't act on mic input at all (see the
        // block comment above this section for why); clear any
        // leftover "speaking" state so a stray sound right as a turn
        // starts doesn't bleed into next time it's genuinely your turn.
        if (vadStateRef.current === "speaking") {
          vadStateRef.current = "idle";
          discardUtterance();
        }
        return;
      }

      const now = performance.now();
      if (vadStateRef.current === "idle") {
        if (rms > VAD_SPEECH_RMS) {
          vadStateRef.current = "speaking";
          speechStartAt = now;
          lastAboveAt = now;
          beginUtterance();
        }
      } else {
        if (rms > VAD_SILENCE_RMS) {
          lastAboveAt = now;
        } else if (now - lastAboveAt > VAD_SILENCE_HOLD_MS) {
          vadStateRef.current = "idle";
          if (now - speechStartAt > VAD_MIN_UTTERANCE_MS) {
            void finishUtteranceAndSubmit();
          } else {
            discardUtterance(); // too short to be real speech — likely noise
          }
        }
      }
    };
    tick();
  }

  function stopVadLoop() {
    if (vadRafRef.current) cancelAnimationFrame(vadRafRef.current);
    vadRafRef.current = null;
    vadStateRef.current = "idle";
    discardUtterance();
  }

  function stopMic() {
    stopVadLoop();
    micOnRef.current = false;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    micVadCtxRef.current?.close().catch(() => {});
    micVadCtxRef.current = null;
    micVadAnalyserRef.current = null;
    setMicAnalyserState(null);
    setMicOn(false);
  }

  async function toggleMic() {
    if (micOn) {
      stopMic();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error("Microphone access needs HTTPS (or localhost) — this page isn't loaded over a secure connection");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      const AudioCtx = getAudioContextCtor();
      if (AudioCtx) {
        const ctx = new AudioCtx();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        micVadCtxRef.current = ctx;
        micVadAnalyserRef.current = analyser;
        setMicAnalyserState(analyser);
      }
      micOnRef.current = true;
      setMicOn(true);
      startVadLoop();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Microphone access was denied");
    }
  }

  function stopAllMedia() {
    stopMic();
    stopCamera();
  }

  // Joining the "call": camera + mic both auto-start the first time a
  // session becomes live, same as any real video-call app — same
  // reasoning `beginUtterance` etc. already document; a failure here
  // (denied permission) just surfaces its own toast and leaves the
  // toggle off, not a broken session.
  const autoStartedForSessionRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (phase !== "session" || !activeSessionId) return;
    if (autoStartedForSessionRef.current === activeSessionId) return;
    autoStartedForSessionRef.current = activeSessionId;
    void toggleCamera();
    void toggleMic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, activeSessionId]);

  React.useEffect(() => {
    return () => stopAllMedia();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Playback of an ALREADY-STORED past turn's audio (the ▶ replay
  // button) — a plain <audio> element + one-shot blob fetch is fine
  // here, nothing is being generated live. Separate from the live PCM
  // streaming engine below. ---
  const audioElRef = React.useRef<HTMLAudioElement | null>(null);
  const playbackGraphRef = React.useRef<{ ctx: AudioContext; analyser: AnalyserNode } | null>(null);
  const [isPlaying, setIsPlaying] = React.useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = React.useState(false);

  // createMediaElementSource can only ever be called ONCE per <audio>
  // element (a second call throws) — this element is reused across
  // every replay (only its `src` changes), so the graph is built
  // lazily on first playback and kept for the element's whole
  // lifetime, never rebuilt.
  function ensurePlaybackGraph(): { ctx: AudioContext; analyser: AnalyserNode } | null {
    if (playbackGraphRef.current) return playbackGraphRef.current;
    const el = audioElRef.current;
    const AudioCtx = getAudioContextCtor();
    if (!el || !AudioCtx) return null;
    try {
      const ctx = new AudioCtx();
      const source = ctx.createMediaElementSource(el);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      playbackGraphRef.current = { ctx, analyser };
      return playbackGraphRef.current;
    } catch {
      return null; // visualization only — the <audio> element still plays fine without it
    }
  }

  function handleAudioPlay() {
    setIsPlaying(true);
    setAutoplayBlocked(false);
    const graph = ensurePlaybackGraph();
    graph?.ctx.resume().catch(() => {});
    setReplayAnalyserState(graph?.analyser ?? null);
  }

  function handleAudioStop() {
    setIsPlaying(false);
  }

  React.useEffect(() => {
    return () => {
      playbackGraphRef.current?.ctx.close().catch(() => {});
    };
  }, []);

  React.useEffect(() => {
    if (!audioUrl) return;
    (() => setAutoplayBlocked(false))();
    // Explicit .play() rather than relying on the <audio> element's
    // `autoPlay` attribute — that only fires on the element's initial
    // mount, not on every later `src` change across turns.
    audioElRef.current?.play().catch(() => {
      // Autoplay blocked (the browser doesn't count "clicked a button
      // a few seconds ago, then waited through a network round-trip"
      // as a fresh-enough gesture) — the question's full text is
      // always shown regardless, so this never breaks the session,
      // but surface a real manual Play control rather than silently
      // dropping the audio.
      setAutoplayBlocked(true);
    });
  }, [audioUrl]);

  function handleManualPlay() {
    audioElRef.current?.play().catch((e) => {
      toast.error(e instanceof Error ? e.message : "Couldn't play the audio");
    });
  }

  // --- Live PCM streaming playback (raised directly by Adrian: hear
  // the reply as it's being generated, not the whole clip at once) —
  // separate from the <audio>/blob engine above. Raw 16-bit PCM
  // chunks arrive as audio_chunk SSE events and are scheduled back-to-
  // back on a shared AudioContext for gapless playback as they
  // arrive, rather than waiting for the full clip. ---
  const pcmCtxRef = React.useRef<AudioContext | null>(null);
  const pcmAnalyserRef = React.useRef<AnalyserNode | null>(null);
  const pcmFormatRef = React.useRef<{ sampleRate: number; channels: number } | null>(null);
  const pcmNextStartRef = React.useRef(0);
  // Any trailing bytes from the last audio_chunk that didn't complete
  // a full sample-frame (2 bytes x channel count) — carried over and
  // prepended to the NEXT chunk. SSE/network chunk boundaries have no
  // relationship whatsoever to PCM sample boundaries; treating every
  // chunk as its own fresh byte stream starting at frame 0 (the
  // original bug here) desyncs every sample after the first
  // odd-length chunk, which is exactly what plain static sounds like
  // — not a provider/model incompatibility.
  const pcmLeftoverRef = React.useRef<Uint8Array>(new Uint8Array(0));
  const [pcmAutoplayBlocked, setPcmAutoplayBlocked] = React.useState(false);

  function ensurePcmGraph(): { ctx: AudioContext; analyser: AnalyserNode } | null {
    if (pcmCtxRef.current && pcmAnalyserRef.current) {
      return { ctx: pcmCtxRef.current, analyser: pcmAnalyserRef.current };
    }
    const AudioCtx = getAudioContextCtor();
    if (!AudioCtx) return null;
    const ctx = new AudioCtx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.connect(ctx.destination);
    pcmCtxRef.current = ctx;
    pcmAnalyserRef.current = analyser;
    return { ctx, analyser };
  }

  function handleAudioStreamStart(sampleRate: number, channels: number, role: "moderator" | "discusser") {
    const graph = ensurePcmGraph();
    if (!graph) return;
    pcmFormatRef.current = { sampleRate, channels };
    // Leftover bytes never carry across a SEGMENT boundary (each is
    // its own independent synthesis stream), but the gapless-
    // scheduling cursor DOES carry across segments within the same
    // turn — only reset it for the first segment.
    pcmLeftoverRef.current = new Uint8Array(0);
    // The moment THIS segment will actually start playing on the
    // AudioContext's own clock: "now" for a turn's first segment
    // (pcmNextStartRef gets reset to now, below); for every later
    // segment, wherever the previous segment's gapless scheduling left
    // off (pcmNextStartRef already holds exactly that — playPcmChunk
    // only ever advances it forward as it schedules chunks). NOT "now"
    // in either case for THIS event's own arrival time — audio_start
    // fires as soon as the server begins streaming a segment, which,
    // since synthesis+network delivery is faster than real playback,
    // can arrive well before the previous segment has actually
    // finished sounding. Flipping the visualizer/role on event arrival
    // (the original bug here) showed the next speaker while the
    // previous one's voice was still audibly playing.
    const segmentStartAt = turnHasAudioRef.current ? pcmNextStartRef.current : graph.ctx.currentTime;
    if (!turnHasAudioRef.current) {
      pcmNextStartRef.current = graph.ctx.currentTime;
      turnHasAudioRef.current = true;
    }
    setIsPlaying(true);
    setPcmAutoplayBlocked(false);
    setPcmAnalyserState(graph.analyser);
    graph.ctx.resume().catch(() => {});
    const roleDelayMs = Math.max(0, (segmentStartAt - graph.ctx.currentTime) * 1000);
    window.setTimeout(() => setCurrentSpeakerRole(role), roleDelayMs);
    // Same autoplay-policy gap the <audio> element's own .play() call
    // can hit — a freshly-created context sometimes stays suspended
    // until a "fresh enough" user gesture resumes it, in which case
    // nothing scheduled below actually makes sound until resumed.
    window.setTimeout(() => {
      if (pcmCtxRef.current?.state === "suspended") setPcmAutoplayBlocked(true);
    }, 400);
  }

  function playPcmChunk(base64Data: string) {
    const fmt = pcmFormatRef.current;
    const graph = ensurePcmGraph();
    if (!fmt || !graph) return;
    const binary = atob(base64Data);
    const newBytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) newBytes[i] = binary.charCodeAt(i);

    // Prepend whatever didn't complete a full sample-frame last time
    // (see pcmLeftoverRef's own comment for why this matters), then
    // hold back whatever doesn't complete one THIS time for the next
    // chunk — 16-bit signed PCM, little-endian, interleaved by
    // channel, exactly what interview_media.py always requests from
    // the provider (response_format="pcm").
    const leftover = pcmLeftoverRef.current;
    const bytes = leftover.length > 0 ? new Uint8Array(leftover.length + newBytes.length) : newBytes;
    if (leftover.length > 0) {
      bytes.set(leftover, 0);
      bytes.set(newBytes, leftover.length);
    }

    const bytesPerFrame = 2 * fmt.channels;
    const usableLength = bytes.length - (bytes.length % bytesPerFrame);
    pcmLeftoverRef.current = bytes.slice(usableLength);
    if (usableLength <= 0) return;

    const view = new DataView(bytes.buffer, 0, usableLength);
    const frameCount = usableLength / bytesPerFrame;
    const audioBuffer = graph.ctx.createBuffer(fmt.channels, frameCount, fmt.sampleRate);
    for (let ch = 0; ch < fmt.channels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < frameCount; i++) {
        channelData[i] = view.getInt16(i * bytesPerFrame + ch * 2, true) / 32768;
      }
    }
    const source = graph.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(graph.analyser);
    const startAt = Math.max(pcmNextStartRef.current, graph.ctx.currentTime);
    source.start(startAt);
    pcmNextStartRef.current = startAt + audioBuffer.duration;
  }

  // Called once per TURN (on the "done" event), not per segment —
  // waits for whatever's still scheduled to actually finish playing
  // before clearing the "speaking" visual state, so FGD/LGD's several
  // back-to-back segments don't flicker the visualizer off between
  // them.
  function settleAudioAfterTurn() {
    const ctx = pcmCtxRef.current;
    const remainingMs =
      ctx && turnHasAudioRef.current ? Math.max(0, (pcmNextStartRef.current - ctx.currentTime) * 1000) : 0;
    window.setTimeout(() => {
      setIsPlaying(false);
      setCurrentSpeakerRole(null);
    }, remainingMs + 50);
  }

  function handleResumePcmAudio() {
    pcmCtxRef.current?.resume().catch((e) => {
      toast.error(e instanceof Error ? e.message : "Couldn't resume audio");
    });
    setPcmAutoplayBlocked(false);
  }

  React.useEffect(() => {
    return () => {
      pcmCtxRef.current?.close().catch(() => {});
    };
  }, []);

  // Plain interview mode: one visualizer, carrying the whole turn-
  // level state (listening/thinking/speaking). FGD/LGD (below):
  // TWO visualizers — raised directly by Adrian, a group discussion
  // needs its moderator and its other participant(s) to visibly be
  // different "speakers", not one indicator standing in for both.
  // The moderator panel still carries the turn-level listening/
  // thinking states (it's the "host" of the session); the discusser
  // panel only ever lights up for its own "speaking" moments.
  const isFgdLgd = activePracticeType === "fgd" || activePracticeType === "lgd";
  const visualizerState: VisualizerState =
    isPlaying && (!isFgdLgd || currentSpeakerRole === "moderator")
      ? "speaking"
      : running
        ? "thinking"
        : micOn
          ? "listening"
          : "idle";
  const discusserVisualizerState: VisualizerState = isPlaying && currentSpeakerRole === "discusser" ? "speaking" : "idle";

  function visualizerAnalyserFor(state: VisualizerState): AnalyserNode | null {
    if (state === "speaking") return pcmAnalyserState ?? replayAnalyserState;
    if (state === "listening") return micAnalyserState;
    return null;
  }

  return (
    <div className="flex h-full flex-col">
      <header className="h-12 shrink-0 border-b border-border bg-card flex items-center justify-between px-5">
        <span className="text-sm font-semibold">Interview Practice</span>
        {phase === "session" && session && (
          <span className="text-xs text-muted-foreground truncate max-w-md">
            {INTERVIEW_PRACTICE_TYPE_LABEL[session.practice_type]}
            {(session.role_title || session.company_name) &&
              ` · ${[session.role_title, session.company_name].filter(Boolean).join(" @ ")}`}
          </span>
        )}
      </header>

      {/* Always mounted so audioElRef never nullifies between replays.
          `audioUrl` is always a blob: URL (loadAudio fetches the
          audio as an authenticated blob, not a direct cross-origin
          link) — a direct link + crossOrigin="anonymous" hard-fails
          the element with "no supported source" the instant a CORS
          check doesn't line up (confirmed live); a blob: URL is
          same-origin from the page's own point of view, so that
          failure mode (and the plain-silent-audio one an unlabeled
          cross-origin load would hit with the Web Audio graph below)
          isn't possible. */}
      <audio
        ref={audioElRef}
        src={audioUrl ?? undefined}
        onPlay={handleAudioPlay}
        onPause={handleAudioStop}
        onEnded={handleAudioStop}
        className="hidden"
      />

      <div className="flex-1 overflow-y-auto p-5">
        {phase === "loading" && <div className="text-sm text-muted-foreground font-mono">loading…</div>}

        {phase === "starting" && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
            <div className="text-sm font-medium">Setting up your session…</div>
            <p className="max-w-sm text-xs text-muted-foreground">
              The interviewer is reading the role and your profile to prepare its first question — this can take a
              moment, especially for a longer job description.
            </p>
          </div>
        )}

        {phase === "ending" && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
            <div className="text-sm font-medium">Scoring your session…</div>
            <p className="max-w-sm text-xs text-muted-foreground">
              Reading back the full transcript and preparing your feedback.
            </p>
          </div>
        )}

        {phase === "list" && (
          <div className="flex flex-col gap-4 max-w-2xl">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground max-w-lg">
                Practice a mock interview, focus group discussion, or leaderless group discussion — real voice,
                scored with AI feedback afterward.
              </p>
              <Button onClick={startNewFromScratch} disabled={!selectedPersonaId}>
                New practice
              </Button>
            </div>
            {!selectedPersonaId ? (
              <div className="text-sm text-muted-foreground">Select a persona from the sidebar first.</div>
            ) : loadingList ? (
              <div className="text-sm text-muted-foreground font-mono">loading…</div>
            ) : sessions.length === 0 ? (
              <div className="border border-dashed border-input p-8 text-center text-sm text-muted-foreground">
                No practice sessions yet.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {sessions.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center gap-2 border border-border bg-card px-3 py-2.5 hover:border-primary transition-colors"
                  >
                    <button
                      type="button"
                      onClick={() => openSession(s.id)}
                      className="flex flex-1 min-w-0 items-center justify-between gap-3 text-left"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">
                          {[s.role_title, s.company_name].filter(Boolean).join(" @ ") ||
                            INTERVIEW_PRACTICE_TYPE_LABEL[s.practice_type]}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {INTERVIEW_PRACTICE_TYPE_LABEL[s.practice_type]} ·{" "}
                          {new Date(s.created_at).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </div>
                      </div>
                      <Badge variant={s.status === "in_progress" ? "secondary" : "outline"} className="font-mono shrink-0">
                        {s.overall_score !== null ? `${s.overall_score.toFixed(0)}/100` : s.status}
                      </Badge>
                    </button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="shrink-0 text-muted-foreground hover:text-crit"
                      disabled={deletingId === s.id}
                      onClick={(e) => handleDeleteSession(s, e)}
                      title="Delete this practice session"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {phase === "new" && (
          <div className="flex flex-col gap-4 max-w-xl">
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setPhase("list")}>
              ← Back
            </Button>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>Practice type</Label>
                <Select value={practiceType} onValueChange={(v) => setPracticeType(v as InterviewPracticeType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INTERVIEW_PRACTICE_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {INTERVIEW_PRACTICE_TYPE_LABEL[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Seniority (optional)</Label>
                <Select value={seniority || undefined} onValueChange={setSeniority}>
                  <SelectTrigger>
                    <SelectValue placeholder="Any" />
                  </SelectTrigger>
                  <SelectContent>
                    {SENIORITY_OPTIONS.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {practiceType === "interview" && (
              <div className="flex flex-col gap-1.5">
                <Label>Category (optional — omit for a mix of everything)</Label>
                <Select value={category || undefined} onValueChange={(v) => setCategory(v as InterviewCategory)}>
                  <SelectTrigger>
                    <SelectValue placeholder="All categories" />
                  </SelectTrigger>
                  <SelectContent>
                    {INTERVIEW_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {INTERVIEW_CATEGORY_LABEL[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label>Target</Label>
              <div className="flex gap-1.5">
                <Button size="sm" variant={targetMode === "job" ? "default" : "outline"} onClick={() => handleTargetModeChange("job")}>
                  From a job listing
                </Button>
                <Button size="sm" variant={targetMode === "manual" ? "default" : "outline"} onClick={() => handleTargetModeChange("manual")}>
                  Role / company
                </Button>
              </div>
            </div>

            {targetMode === "job" ? (
              <div className="flex flex-col gap-2">
                <Input placeholder="Search your Job Inbox…" value={jobSearch} onChange={(e) => setJobSearch(e.target.value)} />
                <div className="flex flex-col gap-1.5 max-h-56 overflow-y-auto">
                  {loadingJobs ? (
                    <span className="text-xs text-muted-foreground font-mono">loading…</span>
                  ) : jobs.length === 0 ? (
                    <span className="text-xs text-muted-foreground">No jobs found.</span>
                  ) : (
                    jobs.map((job) => (
                      <button
                        key={job.id}
                        type="button"
                        onClick={() => setJobId(job.id)}
                        className={cn(
                          "text-left border px-2.5 py-2 text-xs transition-colors",
                          jobId === job.id ? "border-primary bg-primary/5" : "border-border hover:border-primary",
                        )}
                      >
                        <div className="font-medium">{job.title}</div>
                        <div className="text-muted-foreground">{job.company_name_raw}</div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label>Role (optional)</Label>
                  <Input placeholder="e.g. Backend Engineer" value={roleTitle} onChange={(e) => setRoleTitle(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Company (optional)</Label>
                  <Input placeholder="e.g. Google" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
                </div>
              </div>
            )}

            <Button onClick={handleCreateSession} disabled={creating}>
              {creating ? "Starting…" : "Start practice"}
            </Button>
          </div>
        )}

        {phase === "session" && (
          <div className="flex flex-col gap-4 h-full">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 flex-1 min-h-[320px]">
              {/* Your camera — a local self-view only, never uploaded/analyzed */}
              <div className="relative rounded-md border border-border bg-black overflow-hidden flex items-center justify-center min-h-[240px]">
                <video
                  ref={cameraVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className={cn("h-full w-full object-cover [transform:scaleX(-1)]", !cameraOn && "hidden")}
                />
                {!cameraOn && (
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <VideoOff className="size-8" strokeWidth={1.5} />
                    <span className="text-xs">Camera is off</span>
                  </div>
                )}
                <div
                  className={cn(
                    "pointer-events-none absolute inset-0 rounded-md ring-2 transition-colors",
                    vadListening ? "ring-primary" : "ring-transparent",
                  )}
                />
              </div>

              {/* The audio visualizer — color + shape reflect listening/thinking/speaking.
                  FGD/LGD gets two: the moderator (carries the overall
                  turn state) and the other discussion participant(s)
                  (only ever lights up for its own speaking moments) —
                  raised directly by Adrian, a group discussion needs
                  visibly distinct speakers, not one shared indicator. */}
              {isFgdLgd ? (
                <div className="rounded-md border border-border bg-card grid grid-cols-2 gap-2 p-4 min-h-[240px]">
                  <div className="flex flex-col items-center justify-center gap-2">
                    <AudioVisualizer state={visualizerState} analyser={visualizerAnalyserFor(visualizerState)} size={140} />
                    <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                      {VISUALIZER_LABEL[visualizerState]}
                    </span>
                    <span className="text-[9px] text-muted-foreground">Moderator</span>
                  </div>
                  <div className="flex flex-col items-center justify-center gap-2">
                    <AudioVisualizer
                      state={discusserVisualizerState}
                      analyser={visualizerAnalyserFor(discusserVisualizerState)}
                      size={140}
                    />
                    <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                      {VISUALIZER_LABEL[discusserVisualizerState]}
                    </span>
                    <span className="text-[9px] text-muted-foreground">Discussant</span>
                  </div>
                </div>
              ) : (
                <div className="rounded-md border border-border bg-card flex flex-col items-center justify-center gap-3 p-4 min-h-[240px]">
                  <AudioVisualizer state={visualizerState} analyser={visualizerAnalyserFor(visualizerState)} />
                  <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                    {VISUALIZER_LABEL[visualizerState]}
                  </span>
                </div>
              )}
            </div>

            {autoplayBlocked && (
              <div className="flex justify-center">
                <Button size="sm" variant="outline" onClick={handleManualPlay}>
                  <Volume2 className="size-3.5" />
                  Play the question&apos;s audio
                </Button>
              </div>
            )}
            {pcmAutoplayBlocked && (
              <div className="flex justify-center">
                <Button size="sm" variant="outline" onClick={handleResumePcmAudio}>
                  <Volume2 className="size-3.5" />
                  Resume audio
                </Button>
              </div>
            )}

            <div className="flex justify-center gap-2">
              <Button
                size="lg"
                variant={micOn ? "default" : "outline"}
                onClick={toggleMic}
                disabled={session?.status !== "in_progress"}
                className="size-12 rounded-full p-0"
                title={micOn ? "Mute" : "Unmute"}
              >
                {micOn ? <Mic className="size-5" /> : <MicOff className="size-5" />}
              </Button>
              <Button
                size="lg"
                variant={cameraOn ? "default" : "outline"}
                onClick={toggleCamera}
                className="size-12 rounded-full p-0"
                title={cameraOn ? "Turn camera off" : "Turn camera on"}
              >
                {cameraOn ? <Video className="size-5" /> : <VideoOff className="size-5" />}
              </Button>
              <Button variant="destructive" onClick={handleEndSession} disabled={running}>
                End session
              </Button>
            </div>

            <details className="group">
              <summary className="cursor-pointer select-none text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                Transcript log
              </summary>
              <div className="mt-2">
                <TranscriptView
                  items={transcript}
                  running={running}
                  stageMessage={stageMessage}
                  onReplay={handleReplay}
                />
              </div>
            </details>
          </div>
        )}

        {phase === "results" && session && (
          <div className="flex flex-col gap-4 max-w-2xl">
            <div className="border border-border bg-card p-4 flex flex-col gap-1">
              <span className="font-mono text-[10px] tracking-wider uppercase text-muted-foreground">Overall score</span>
              <span className="font-mono text-3xl font-semibold">
                {session.overall_score !== null
                  ? `${session.overall_score.toFixed(0)}/100`
                  : session.status === "cancelled"
                    ? "No answers recorded"
                    : "—"}
              </span>
            </div>

            {session.feedback && (
              <>
                <p className="text-sm">{session.feedback.summary}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {session.feedback.categories.map((c, i) => (
                    <div key={i} className="border border-border p-3 text-xs space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{c.category}</span>
                        <Badge variant="outline" className="font-mono">
                          {c.score.toFixed(0)}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground">{c.notes}</p>
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Strengths</div>
                    <ul className="list-disc pl-4 space-y-1">
                      {session.feedback.strengths.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
                      Areas to improve
                    </div>
                    <ul className="list-disc pl-4 space-y-1">
                      {session.feedback.areas_to_improve.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </>
            )}

            {transcript.length > 0 && (
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Transcript</div>
                <TranscriptView
                  items={transcript}
                  running={false}
                  stageMessage={null}
                  onReplay={handleReplay}
                />
              </div>
            )}

            <div className="flex gap-2">
              <Button onClick={startNewFromScratch}>Practice again</Button>
              <Button variant="outline" onClick={backToList}>
                Back to list
              </Button>
              <Button
                variant="outline"
                className="text-crit hover:text-crit"
                disabled={deletingId === session.id}
                onClick={() => handleDeleteSession(session)}
              >
                <Trash2 className="size-3.5" />
                Delete
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
