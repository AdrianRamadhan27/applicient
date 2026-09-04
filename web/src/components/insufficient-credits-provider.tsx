"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { setInsufficientCreditsHandler } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Phase 16 — a real dialog (not a toast) for a 402 "out of credits"
 * response, wherever in the app it happens. Mounted once, above
 * routing (layout.tsx, same convention ConversationProvider/
 * PersonaProvider already establish) — `api.ts`'s `request()` and
 * `checkStreamResponse` (used by every SSE-streaming endpoint) both
 * call `setInsufficientCreditsHandler`'s registered function on any
 * 402, so this fires from ANY page's action without that page needing
 * to know this dialog exists. The Assistant's own pre-flight
 * confirmation for a credit-gated tool call (orchestrator_tools.py)
 * surfaces the same "insufficient" case through its own interrupt UI
 * instead (assistant/page.tsx, floating-assistant.tsx) — this dialog
 * only ever fires for a direct feature call outside the Assistant. */
export function InsufficientCreditsProvider() {
  const router = useRouter();
  const [message, setMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    setInsufficientCreditsHandler((msg) => setMessage(msg));
    return () => setInsufficientCreditsHandler(null);
  }, []);

  function close() {
    setMessage(null);
  }

  function goToBilling() {
    setMessage(null);
    router.push("/console/billing");
  }

  return (
    <Dialog open={message !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Out of credits</DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Not now
          </Button>
          <Button onClick={goToBilling}>Go to Billing</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
