"use client";

import * as React from "react";
import { Bot, User, FileText, Check, Hand, Mic, MicOff, Video, VideoOff, UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAutoSequence } from "./use-auto-sequence";

// The whole hero, replacing the old tab-cycling dashboard mock — Adrian,
// direct: "In hero it should just be chat/assistant. But it mocks every
// feature step by step. From first uploading cv and parsing, job search
// and getting results. tailoring cv to job groups. running apply
// pipeline. then practicing interview. All in 1 chat that user can
// scroll to the top. Just like in conversify.id."
//
// One long scripted conversation — same bubble visual language as
// chat-log.tsx (bot/user avatar circles, rounded-lg bubbles) but
// self-contained and hardcoded, same reasoning job-search-chat-mock.tsx
// already documented for not reusing ChatLog directly. Every "step" is
// either a chat bubble, a transient typing indicator, or a small feature
// card (job results, verifier verdict, apply status, interview practice)
// — revealed cumulatively via useAutoSequence, auto-scrolling to the
// newest one exactly like the real ChatLog does, while staying manually
// scrollable at any point (pauses on hover, same as every other mock).
// Adrian, direct: "the chat in the hero shouldnt loop. Unless
// refreshed" — plays through once (useAutoSequence's loop:false) and
// then just sits on the finished conversation.

const STEP_INTERVAL_MS = 1700;

type Event =
  | { revealAt: number; kind: "user"; text: string }
  | { revealAt: number; kind: "assistant"; text: string }
  | { revealAt: number; kind: "typing" }
  | { revealAt: number; kind: "card"; node: React.ReactNode };

const JOB_RESULTS: { title: string; company: string; rank: "ok" | "warn" | "muted" }[] = [
  { title: "Backend Engineer", company: "Acme Corp", rank: "ok" },
  { title: "Platform Engineer", company: "Northwind", rank: "ok" },
  { title: "Software Engineer II", company: "Globex", rank: "warn" },
];

const RANK_CLASSES: Record<string, string> = { ok: "bg-ok", warn: "bg-warn", muted: "bg-muted-foreground" };

function Card({ children }: { children: React.ReactNode }) {
  return <div className="ml-10 flex max-w-[85%] flex-col gap-2 border border-border bg-secondary/30 px-4 py-3">{children}</div>;
}

const INTERVIEW_BAR_HEIGHTS = [10, 16, 12, 18, 9];

// The one card in the script that's more than a static illustration —
// Adrian, direct: this step "should be popping up the interview practice
// UI of camera (with avatar) and audio visualizer with mute and camera
// button inside the chat". Mirrors the real interview-practice layout
// (camera left, visualizer right) the way dashboard-mock.tsx's old
// InterviewTab and the carousel's InterviewPracticeMock both already do,
// but no real getUserMedia here — this is one card inside an
// auto-playing narrative, not a standalone "try it" demo; the mute/
// camera buttons are real clicks with local visual state, not just
// decoration, same "interactable but nothing happens" idea as every
// other mock.
function InterviewPreviewCard() {
  const [muted, setMuted] = React.useState(false);
  const [cameraOn, setCameraOn] = React.useState(true);

  return (
    <Card>
      <div className="flex items-center gap-2">
        <Bot className="size-4 shrink-0 text-primary" strokeWidth={1.5} />
        <span className="text-xs">Tell me about a time you solved a difficult technical problem.</span>
      </div>
      <div className="flex gap-2">
        <div className="flex aspect-video flex-1 items-center justify-center border border-border bg-secondary/40">
          {cameraOn ? (
            <div className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
              <UserRound className="size-5" strokeWidth={1.5} />
            </div>
          ) : (
            <VideoOff className="size-5 text-muted-foreground/60" strokeWidth={1.5} />
          )}
        </div>
        <div className="flex w-16 shrink-0 flex-col items-center justify-center gap-1 border border-border bg-secondary/25">
          <div className="flex items-end gap-1">
            {INTERVIEW_BAR_HEIGHTS.map((h, i) => (
              <span
                key={i}
                className={cn("w-1.5 rounded-sm bg-primary", !muted && "anim-bar-pulse")}
                style={{ height: `${h}px`, animationDelay: `${i * 0.12}s` }}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={(e) => {
            e.stopPropagation();
            setMuted((m) => !m);
          }}
          className={cn(
            "flex items-center gap-1 border px-2 py-1 font-mono text-[10px]",
            muted ? "border-crit text-crit" : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          {muted ? <MicOff className="size-3" /> : <Mic className="size-3" />}
          {muted ? "Unmute" : "Mute"}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setCameraOn((c) => !c);
          }}
          className={cn(
            "flex items-center gap-1 border px-2 py-1 font-mono text-[10px]",
            !cameraOn ? "border-crit text-crit" : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          {cameraOn ? <Video className="size-3" /> : <VideoOff className="size-3" />}
          {cameraOn ? "Camera" : "Camera off"}
        </button>
      </div>
    </Card>
  );
}

const EVENTS: Event[] = [
  { revealAt: 0, kind: "user", text: "Here's my CV — can you take a look?" },
  { revealAt: 1, kind: "typing" },
  { revealAt: 2, kind: "assistant", text: "Got it — parsing your CV now…" },
  {
    revealAt: 3,
    kind: "card",
    node: (
      <Card>
        <div className="flex items-center gap-2">
          <FileText className="size-4 shrink-0 text-primary" strokeWidth={1.5} />
          <span className="text-sm font-medium">CV_JohnDoe.pdf parsed</span>
        </div>
        <span className="font-mono text-xs text-muted-foreground">28 evidence items extracted · profile complete</span>
      </Card>
    ),
  },
  { revealAt: 4, kind: "user", text: "Find me backend roles in Jakarta" },
  { revealAt: 5, kind: "typing" },
  { revealAt: 6, kind: "assistant", text: "Searching Greenhouse, Lever, Ashby, Workable… found 14 matches." },
  {
    revealAt: 7,
    kind: "card",
    node: (
      <Card>
        {JOB_RESULTS.map((job) => (
          <div key={job.title} className="flex items-center gap-2">
            <span className={cn("size-1.5 shrink-0", RANK_CLASSES[job.rank])} />
            <span className="flex-1 truncate text-xs font-medium">{job.title}</span>
            <span className="shrink-0 truncate font-mono text-[10px] text-muted-foreground">{job.company}</span>
          </div>
        ))}
      </Card>
    ),
  },
  { revealAt: 8, kind: "user", text: "Tailor my CV for the Acme Corp role" },
  { revealAt: 9, kind: "typing" },
  { revealAt: 10, kind: "assistant", text: "Tailoring now — every claim gets checked against your evidence bank." },
  {
    revealAt: 11,
    kind: "card",
    node: (
      <Card>
        <p className="text-xs text-muted-foreground line-through decoration-crit/60">
          Worked on backend services for the payments team.
        </p>
        <p className="text-xs">Rebuilt the payments retry pipeline, cutting failed-charge recovery time by 40%.</p>
        <span className="flex w-fit items-center gap-1 border border-ok bg-ok-bg px-2 py-0.5 font-mono text-[10px] text-ok">
          <Check className="size-2.5" /> SUPPORTED
        </span>
      </Card>
    ),
  },
  { revealAt: 12, kind: "user", text: "Go ahead and apply" },
  { revealAt: 13, kind: "typing" },
  { revealAt: 14, kind: "assistant", text: "Filling out the application at Acme Corp now…" },
  {
    revealAt: 15,
    kind: "card",
    node: (
      <Card>
        <div className="flex items-center gap-2">
          <Hand className="anim-float size-4 shrink-0 text-warn" strokeWidth={1.5} />
          <span className="font-mono text-xs text-warn">Stopped at Submit — waiting for your review</span>
        </div>
      </Card>
    ),
  },
  { revealAt: 16, kind: "user", text: "Help me prep for the interview" },
  { revealAt: 17, kind: "typing" },
  { revealAt: 18, kind: "assistant", text: "Let's practice — here's your first question." },
  { revealAt: 19, kind: "card", node: <InterviewPreviewCard /> },
  { revealAt: 20, kind: "assistant", text: "You're all set — good luck out there." },
];

const STEP_COUNT = EVENTS[EVENTS.length - 1].revealAt + 1;

function TypingBubble() {
  return (
    <div className="flex animate-in fade-in-0 items-start gap-2.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Bot className="size-4" />
      </div>
      <div className="flex items-center gap-1.5 rounded-lg rounded-tl-none bg-secondary px-4 py-3">
        <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.3s]" />
        <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.15s]" />
        <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce" />
      </div>
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex animate-in fade-in-0 items-start justify-end gap-2.5">
      <div className="max-w-[80%] rounded-lg rounded-tr-none bg-primary px-4 py-2.5 text-sm whitespace-pre-wrap text-primary-foreground">
        {text}
      </div>
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <User className="size-4" />
      </div>
    </div>
  );
}

function AssistantBubble({ text }: { text: string }) {
  return (
    <div className="flex animate-in fade-in-0 items-start gap-2.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Bot className="anim-float size-4" />
      </div>
      <div className="max-w-[80%] rounded-lg rounded-tl-none bg-secondary px-4 py-2.5 text-sm">{text}</div>
    </div>
  );
}

export function HeroChatMock() {
  const { step, pause, resume } = useAutoSequence(STEP_COUNT, STEP_INTERVAL_MS, { loop: false });
  const scrollerRef = React.useRef<HTMLDivElement>(null);

  // Plain scrollTop assignment on this one div, NOT scrollIntoView —
  // scrollIntoView walks up and repositions every scrollable ancestor
  // that doesn't already fully show the target, which includes the page
  // itself. That's what was yanking a visitor scrolled anywhere else on
  // the landing page back up to the hero every time a new message
  // appeared. This only ever touches the chat log's own scroll position.
  React.useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [step]);

  return (
    <div className="flex h-[460px] flex-col text-left" onMouseEnter={pause} onMouseLeave={resume}>
      <div
        ref={scrollerRef}
        className="flex flex-1 flex-col gap-3 overflow-y-auto p-5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {EVENTS.map((e, i) => {
          if (e.kind === "typing") return step === e.revealAt ? <TypingBubble key={i} /> : null;
          if (step < e.revealAt) return null;
          if (e.kind === "user") return <UserBubble key={i} text={e.text} />;
          if (e.kind === "assistant") return <AssistantBubble key={i} text={e.text} />;
          return <React.Fragment key={i}>{e.node}</React.Fragment>;
        })}
      </div>
    </div>
  );
}
