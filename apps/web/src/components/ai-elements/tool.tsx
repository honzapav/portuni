// Copyright 2025 Vercel, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Adapted from AI Elements (https://elements.ai-sdk.dev) `tool`, pulled
// via `npx ai-elements@latest add tool` (ai-elements@1.9.0). Changed:
// `ToolHeaderProps`/`ToolInputProps`/`ToolOutputProps` use this repo's own
// `ToolCallStatus` (three states: started/completed/failed) and plain
// string input/output instead of the `ai` package's `ToolUIPart` --
// domain/runner/types.ts's `ToolCallEvent` never streams a tool's input
// the way that richer union models, and the adapter already serializes
// input/output to strings server-side.

"use client";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ToolCallStatus } from "@/lib/session-chat";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { CodeBlock } from "./code-block";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group not-prose mb-4 w-full rounded-md border", className)}
    {...props}
  />
);

// Own `ToolCallStatus` (domain/runner/types.ts's ToolCallEvent, mirrored in
// lib/session-chat.ts), not the `ai` package's 7-state `ToolUIPart["state"]"
// -- a `tool_call` event never streams its input, so there is no
// "input-streaming"/"input-available" distinction, and permission asks are
// their own `question` event (rendered via Confirmation), not a tool state.
export type ToolHeaderProps = {
  title?: string;
  tool: string;
  state: ToolCallStatus;
  className?: string;
};

const statusLabels: Record<ToolCallStatus, string> = {
  started: "Running",
  completed: "Completed",
  failed: "Error",
};

const statusIcons: Record<ToolCallStatus, ReactNode> = {
  started: <ClockIcon className="size-4 animate-pulse" />,
  completed: <CheckCircleIcon className="size-4 text-green-600" />,
  failed: <XCircleIcon className="size-4 text-red-600" />,
};

export const getStatusBadge = (status: ToolCallStatus) => (
  <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

export const ToolHeader = ({ className, title, tool, state, ...props }: ToolHeaderProps) => (
  <CollapsibleTrigger
    className={cn(
      "flex w-full items-center justify-between gap-4 p-3",
      className
    )}
    {...props}
  >
    <div className="flex items-center gap-2">
      <WrenchIcon className="size-4 text-muted-foreground" />
      <span className="font-medium text-sm">{title ?? tool}</span>
      {getStatusBadge(state)}
    </div>
    <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
  </CollapsibleTrigger>
);

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-4 p-4 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  />
);

// `input_summary` (ToolCallEvent.payload) is already a JSON-stringified
// string by the time it reaches here -- the adapter serializes it once,
// server-side, so this only ever renders a string, never an arbitrary
// value.
export type ToolInputProps = ComponentProps<"div"> & {
  input: string;
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <div className="rounded-md bg-muted/50">
      <CodeBlock code={input} language="json" />
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: string | null;
  errorText: string | null;
};

export const ToolOutput = ({ className, output, errorText, ...props }: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground"
        )}
      >
        {errorText && <div>{errorText}</div>}
        {output && <CodeBlock code={output} language="json" />}
      </div>
    </div>
  );
};
