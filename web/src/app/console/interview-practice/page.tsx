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
 * FGD/LGD's multi-speaker reply is rendered as separate labeled
 * blocks (see AgentReplyText below) but is still synthesized and
 * played back as ONE audio stream covering every speaker's lines, not
 * a separate clip per speaker with a distinct voice — a disclosed
 * simplification, not the full per-speaker-voice build the plan
 * describes as a possible follow-up.
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
import { Mic, MicOff, Trash2, Video, VideoOff, Volume2 } from "lucide-react";

const SENIORITY_OPTIONS = ["intern", "junior", "mid", "senior", "lead", "staff", "principal"];

type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string; audioFilename?: string };

type Phase = "list" | "new" | "session" | "results" | "loading";

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

function AudioVisualizer({ state, analyser }: { state: VisualizerState; analyser: AnalyserNode | null }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const ctx2d = canvas?.getContext("2d");
    if (!canvas || !ctx2d) return;

    const size = 240;
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
  }, [state, analyser]);

  return <canvas ref={canvasRef} style={{ width: 240, height: 240 }} className="mx-auto" />;
}

function buildTranscriptFromEvents(
  events: { type: InterviewTurnEvent["type"]; data: Record<string, unknown> }[],
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const e of events) {
    if (e.type === "message" && e.data.role === "user") {
      items.push({ kind: "user", text: String(e.data.text ?? "") });
    } else if (e.type === "done") {
      items.push({
        kind: "agent",
        text: String(e.data.reply_text ?? ""),
        audioFilename: e.data.audio_filename ? String(e.data.audio_filename) : undefined,
      });
    }
  }
  return items;
}

function AgentReplyText({ text, practiceType }: { text: string; practiceType: InterviewPracticeType }) {
  if (practiceType === "interview") {
    return <div className="whitespace-pre-wrap">{text}</div>;
  }
  // FGD/LGD's system prompt formats every turn as "Speaker: text"
  // lines (the agent plays the moderator + every simulated
  // participant) — split and labeled here for legibility.
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    <div className="space-y-1.5">
      {lines.map((line, i) => {
        const m = /^([^:]{1,40}):\s(.*)$/.exec(line);
        if (!m) return (
          <div key={i} className="whitespace-pre-wrap">
            {line}
          </div>
        );
        return (
          <div key={i} className="whitespace-pre-wrap">
            <span className="font-semibold text-primary">{m[1]}: </span>
            {m[2]}
          </div>
        );
      })}
    </div>
  );
}

function TranscriptView({
  items,
  practiceType,
  running,
  stageMessage,
  onReplay,
}: {
  items: TranscriptItem[];
  practiceType: InterviewPracticeType;
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
                <AgentReplyText text={item.text} practiceType={practiceType} />
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
const VAD_SILENCE_HOLD_MS = 900;
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
    try {
      for await (const evt of gen) {
        if (evt.type === "stage") {
          setStageMessage(evt.message);
        } else if (evt.type === "message") {
          setTranscript((prev) => [...prev, { kind: "user", text: evt.text }]);
        } else if (evt.type === "audio_start") {
          handleAudioStreamStart(evt.sample_rate, evt.channels);
        } else if (evt.type === "audio_chunk") {
          playPcmChunk(evt.data);
        } else if (evt.type === "audio_end") {
          handleAudioStreamEnd();
        } else if (evt.type === "done") {
          // No loadAudio() here — this turn's reply already played
          // live via the PCM stream above as it arrived. audio_filename
          // is kept only so the ▶ replay button can fetch it again
          // later (results screen, or reopening this session).
          setTranscript((prev) => [
            ...prev,
            { kind: "agent", text: evt.reply_text, audioFilename: evt.audio_filename ?? undefined },
          ]);
        } else if (evt.type === "error") {
          toast.error(evt.message);
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That turn failed");
    } finally {
      setRunning(false);
      setStageMessage(null);
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
      const items = buildTranscriptFromEvents(events);
      setTranscript(items);
      if (s.status !== "in_progress") {
        setPhase("results");
        return;
      }
      setPhase("session");
      if (items.length === 0) {
        // Created via the Assistant's start_interview_practice tool —
        // that's a synchronous tool call, it can't stream the opening
        // turn itself, so it only created the row. Start it now.
        await consumeTurn(sessionId, api.startInterviewSession(sessionId));
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
      setPhase("session");
      router.replace(`/console/interview-practice?session_id=${sessionId}`, { scroll: false });
      await consumeTurn(sessionId, events);
      setSession(await api.getInterviewSession(sessionId));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start session");
    } finally {
      setCreating(false);
    }
  }

  async function handleEndSession() {
    if (!activeSessionId) return;
    stopAllMedia();
    try {
      const updated = await api.endInterviewSession(activeSessionId);
      setSession(updated);
      setPhase("results");
      await refreshList();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to end session");
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

  function handleAudioStreamStart(sampleRate: number, channels: number) {
    const graph = ensurePcmGraph();
    if (!graph) return;
    pcmFormatRef.current = { sampleRate, channels };
    pcmNextStartRef.current = graph.ctx.currentTime;
    pcmLeftoverRef.current = new Uint8Array(0);
    setIsPlaying(true);
    setPcmAutoplayBlocked(false);
    setPcmAnalyserState(graph.analyser);
    graph.ctx.resume().catch(() => {});
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

  function handleAudioStreamEnd() {
    const ctx = pcmCtxRef.current;
    const remainingMs = ctx ? Math.max(0, (pcmNextStartRef.current - ctx.currentTime) * 1000) : 0;
    window.setTimeout(() => setIsPlaying(false), remainingMs + 50);
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

  const visualizerState: VisualizerState = isPlaying ? "speaking" : running ? "thinking" : micOn ? "listening" : "idle";
  const visualizerAnalyser =
    visualizerState === "speaking"
      ? (pcmAnalyserState ?? replayAnalyserState)
      : visualizerState === "listening"
        ? micAnalyserState
        : null;

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

              {/* The audio visualizer — color + shape reflect listening/thinking/speaking */}
              <div className="rounded-md border border-border bg-card flex flex-col items-center justify-center gap-3 p-4 min-h-[240px]">
                <AudioVisualizer state={visualizerState} analyser={visualizerAnalyser} />
                <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                  {VISUALIZER_LABEL[visualizerState]}
                </span>
              </div>
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
                  practiceType={activePracticeType}
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
                  practiceType={activePracticeType}
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
