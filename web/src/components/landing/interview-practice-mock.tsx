"use client";

import * as React from "react";
import { Mic, MicOff, VideoOff, Bot } from "lucide-react";
import { cn } from "@/lib/utils";

// Adrian, direct: "for the interview practice feature actually turn on the
// users camera and mic, they can try out the speaking interview but limit
// it so the ai only reply once then the mic disables cant speak anymore."
// Then, direct again: "must match the actual UI of interview practice
// closely which is camera on the left and audio visualizer on the right
// but with transcript on the bottom... before user even click Try it live
// the camera and visualizer layout already there just not started yet."
//
// Everything here runs entirely in the visitor's own browser: the camera
// preview is a local <video> bound directly to their own MediaStream, and
// the "waveform" is a real Web Audio AnalyserNode reading their actual mic
// input — never recorded, transcribed, or sent anywhere. The AI's question
// and its one reply are both fixed lines — and since they never change,
// they're pre-rendered to real audio files once (web/public/audio/, via
// macOS `say`) instead of calling any TTS on every play, live or
// browser-native (Adrian, direct: "since it always speaks the same script
// first time need to save the tts as a file so not waste tts everytime").
// This is also a public, unauthenticated landing page, so there's no
// backend call here at all to rate-limit or pay for.

type Phase = "idle" | "requesting" | "denied" | "listening" | "replied";

const AI_QUESTION = "Tell me about a time you solved a difficult technical problem under pressure.";
const AI_REPLY =
  "That's a solid example — I like that you quantified the impact. In the full app we'd keep going with a follow-up question.";
const QUESTION_AUDIO_SRC = "/audio/interview-question.m4a";
const REPLY_AUDIO_SRC = "/audio/interview-reply.m4a";
const BAR_COUNT = 5;
const IDLE_LEVELS = Array(BAR_COUNT).fill(0.06);
const AUTO_DONE_MS = 20_000;

export function InterviewPracticeMock() {
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [levels, setLevels] = React.useState<number[]>(IDLE_LEVELS);
  const [aiSpeaking, setAiSpeaking] = React.useState(false);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const questionAudioRef = React.useRef<HTMLAudioElement>(null);
  const replyAudioRef = React.useRef<HTMLAudioElement>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const audioCtxRef = React.useRef<AudioContext | null>(null);
  const rafRef = React.useRef<number | undefined>(undefined);
  const autoDoneRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const stopAnalyser = React.useCallback(() => {
    if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
    rafRef.current = undefined;
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    setLevels(IDLE_LEVELS);
  }, []);

  const stopAllTracks = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // Belt-and-suspenders cleanup — a visitor scrolling away mid-demo
  // shouldn't leave their camera/mic sitting on.
  React.useEffect(() => {
    const questionAudio = questionAudioRef.current;
    const replyAudio = replyAudioRef.current;
    return () => {
      stopAnalyser();
      stopAllTracks();
      clearTimeout(autoDoneRef.current);
      questionAudio?.pause();
      replyAudio?.pause();
    };
  }, [stopAnalyser, stopAllTracks]);

  function startAnalyser(stream: MediaStream) {
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 64;
    source.connect(analyser);
    audioCtxRef.current = ctx;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const bucket = Math.max(1, Math.floor(data.length / BAR_COUNT));

    function tick() {
      analyser.getByteFrequencyData(data);
      const next = Array.from({ length: BAR_COUNT }, (_, i) => {
        let sum = 0;
        for (let j = 0; j < bucket; j++) sum += data[i * bucket + j] ?? 0;
        return Math.min(1, Math.max(0.06, sum / bucket / 255));
      });
      setLevels(next);
      rafRef.current = requestAnimationFrame(tick);
    }
    tick();
  }

  async function handleTryIt() {
    setPhase("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      startAnalyser(stream);
      setPhase("listening");
      questionAudioRef.current?.play().catch(() => {});
      autoDoneRef.current = setTimeout(handleDone, AUTO_DONE_MS);
    } catch {
      setPhase("denied");
    }
  }

  function handleDone() {
    clearTimeout(autoDoneRef.current);
    stopAnalyser();
    // Only the mic goes silent — the camera preview stays up so the
    // visitor can still see themselves while reading the reply.
    streamRef.current?.getAudioTracks().forEach((t) => t.stop());
    setPhase("replied");
    replyAudioRef.current?.play().catch(() => {});
  }

  const hasStream = phase === "listening" || phase === "replied";

  return (
    <div className="flex h-[460px] flex-col gap-4 p-6 text-left">
      <audio ref={questionAudioRef} src={QUESTION_AUDIO_SRC} onPlay={() => setAiSpeaking(true)} onEnded={() => setAiSpeaking(false)} />
      <audio ref={replyAudioRef} src={REPLY_AUDIO_SRC} onPlay={() => setAiSpeaking(true)} onEnded={() => setAiSpeaking(false)} />

      <div className="flex flex-1 gap-3">
        <div className="relative flex-1 overflow-hidden border border-border bg-black">
          {hasStream ? (
            <video ref={videoRef} autoPlay muted playsInline className="h-full w-full scale-x-[-1] object-cover" />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground/50">
              <VideoOff className="size-8" strokeWidth={1.5} />
              <span className="text-xs">Camera off</span>
            </div>
          )}
          {aiSpeaking && (
            <div className="absolute top-2 left-2 flex animate-in fade-in-0 items-center gap-1.5 border border-primary bg-card/90 px-2 py-1">
              <Bot className="anim-float size-3.5 text-primary" strokeWidth={1.5} />
              <span className="font-mono text-[10px] text-primary">AI speaking…</span>
            </div>
          )}
        </div>

        <div className="flex w-20 shrink-0 flex-col items-center justify-center gap-2 border border-border bg-secondary/20">
          {phase === "listening" ? (
            <Mic className="size-4 shrink-0 text-primary" strokeWidth={1.5} />
          ) : (
            <MicOff className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
          )}
          <div className="flex items-end gap-1">
            {levels.map((lvl, i) => (
              <span
                key={i}
                className={cn("w-1.5 rounded-sm", phase === "listening" ? "bg-primary" : "bg-muted-foreground/40")}
                style={{ height: `${10 + lvl * 32}px` }}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="flex min-h-[96px] flex-col gap-2 border-t border-border pt-3">
        {phase === "idle" && (
          <p className="text-sm text-muted-foreground">Transcript will appear here once you start.</p>
        )}
        {phase !== "idle" && (
          <div className="flex items-start gap-2.5 text-left">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Bot className="size-3.5" />
            </div>
            <div className="rounded-lg rounded-tl-none bg-secondary px-3.5 py-2 text-sm">{AI_QUESTION}</div>
          </div>
        )}
        {phase === "listening" && (
          <span className="pl-9 font-mono text-xs text-muted-foreground">Listening — say your answer out loud…</span>
        )}
        {phase === "replied" && (
          <div className="flex animate-in fade-in-0 items-start gap-2.5 text-left">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Bot className="size-3.5" />
            </div>
            <div className="rounded-lg rounded-tl-none bg-secondary px-3.5 py-2 text-sm">{AI_REPLY}</div>
          </div>
        )}
      </div>

      <div className="flex flex-col items-center gap-2 text-center">
        {phase === "idle" && (
          <>
            <button
              onClick={handleTryIt}
              className="border border-primary px-4 py-2 font-mono text-xs text-primary hover:bg-primary/10"
            >
              Try it live (uses your camera &amp; mic)
            </button>
            <span className="text-xs text-muted-foreground">
              Runs entirely in your browser — nothing is recorded or sent anywhere.
            </span>
          </>
        )}
        {phase === "requesting" && <p className="text-sm text-muted-foreground">Waiting for camera &amp; mic permission…</p>}
        {phase === "denied" && (
          <p className="max-w-[320px] text-sm text-muted-foreground">
            Camera/mic access was blocked or unavailable — the demo video above shows how a real session plays out.
          </p>
        )}
        {phase === "listening" && (
          <button
            onClick={handleDone}
            className="border border-primary px-4 py-2 font-mono text-xs text-primary hover:bg-primary/10"
          >
            Done — get feedback
          </button>
        )}
        {phase === "replied" && (
          <span className="text-xs text-muted-foreground">
            Mic disabled — this preview is limited to one question. Sign up to continue the conversation.
          </span>
        )}
      </div>
    </div>
  );
}
