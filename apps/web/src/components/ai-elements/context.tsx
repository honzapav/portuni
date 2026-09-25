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
// Adapted from AI Elements (https://elements.ai-sdk.dev) `context`, pulled
// via `npx ai-elements@latest add context` (ai-elements@1.9.0). Changed:
// the numbers come from props only -- the `ai` `LanguageModelUsage` type
// and the `tokenlens` cost estimate (`ContextContentFooter`,
// `ContextReasoningUsage`, the cost text beside every count) are gone;
// `maxTokens` may be null (the window is unknown until the runner's first
// result), in which case the icon draws no arc and the trigger shows the
// bare count; the trigger text is the `label` prop, formatted by
// lib/context-ring.ts, not an en-US percent; `"use client"` removed.
// The icon's and the usage rows' labels come from the `chat` catalog (#536).

import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { formatTokens } from "@/lib/format";
import { useLocale } from "@/lib/use-locale";
import { type ComponentProps, createContext, useContext } from "react";
import { useTranslation } from "react-i18next";

const PERCENT_MAX = 100;
const ICON_RADIUS = 10;
const ICON_VIEWBOX = 24;
const ICON_CENTER = 12;
const ICON_STROKE_WIDTH = 2;

export type ContextUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
};

type ContextSchema = {
  usedTokens: number;
  maxTokens: number | null;
  label: string;
  usage?: ContextUsage;
};

const ContextContext = createContext<ContextSchema | null>(null);

const useContextValue = () => {
  const context = useContext(ContextContext);
  if (!context) {
    throw new Error("Context components must be used within Context");
  }
  return context;
};

export type ContextProps = ComponentProps<typeof HoverCard> & ContextSchema;

export const Context = ({ usedTokens, maxTokens, label, usage, ...props }: ContextProps) => (
  <ContextContext.Provider value={{ usedTokens, maxTokens, label, usage }}>
    <HoverCard closeDelay={0} openDelay={0} {...props} />
  </ContextContext.Provider>
);

const usedFraction = (usedTokens: number, maxTokens: number | null): number | null =>
  maxTokens === null || maxTokens <= 0 ? null : Math.min(1, usedTokens / maxTokens);

const ContextIcon = () => {
  const { usedTokens, maxTokens } = useContextValue();
  const { t } = useTranslation("chat");
  const circumference = 2 * Math.PI * ICON_RADIUS;
  const fraction = usedFraction(usedTokens, maxTokens);
  const dashOffset = circumference * (1 - (fraction ?? 0));

  return (
    <svg
      aria-label={t(($) => $.context.ring_label)}
      height="20"
      role="img"
      style={{ color: "currentcolor" }}
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
      width="20"
    >
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.25"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
      />
      {fraction !== null && (
        <circle
          cx={ICON_CENTER}
          cy={ICON_CENTER}
          fill="none"
          opacity="0.8"
          r={ICON_RADIUS}
          stroke="currentColor"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={dashOffset}
          strokeLinecap="round"
          strokeWidth={ICON_STROKE_WIDTH}
          style={{ transformOrigin: "center", transform: "rotate(-90deg)" }}
        />
      )}
    </svg>
  );
};

export type ContextTriggerProps = ComponentProps<typeof Button>;

export const ContextTrigger = ({ children, ...props }: ContextTriggerProps) => {
  const { label } = useContextValue();
  return (
    <HoverCardTrigger asChild>
      {children ?? (
        <Button type="button" variant="ghost" {...props}>
          <span className="font-medium">{label}</span>
          <ContextIcon />
        </Button>
      )}
    </HoverCardTrigger>
  );
};

export type ContextContentProps = ComponentProps<typeof HoverCardContent>;

export const ContextContent = ({ className, ...props }: ContextContentProps) => (
  <HoverCardContent className={cn("min-w-60 divide-y overflow-hidden p-0", className)} {...props} />
);

export type ContextContentHeaderProps = ComponentProps<"div">;

export const ContextContentHeader = ({ children, className, ...props }: ContextContentHeaderProps) => {
  const { usedTokens, maxTokens, label } = useContextValue();
  const locale = useLocale();
  const fraction = usedFraction(usedTokens, maxTokens);

  return (
    <div className={cn("w-full space-y-2 p-3", className)} {...props}>
      {children ?? (
        <>
          <div className="flex items-center justify-between gap-3 text-xs">
            <p>{label}</p>
            <p className="font-mono text-muted-foreground">
              {maxTokens === null
                ? formatTokens(locale, usedTokens)
                : `${formatTokens(locale, usedTokens)} / ${formatTokens(locale, maxTokens)}`}
            </p>
          </div>
          {fraction !== null && (
            <div className="space-y-2">
              <Progress className="bg-muted" value={fraction * PERCENT_MAX} />
            </div>
          )}
        </>
      )}
    </div>
  );
};

export type ContextContentBodyProps = ComponentProps<"div">;

export const ContextContentBody = ({ children, className, ...props }: ContextContentBodyProps) => (
  <div className={cn("w-full p-3", className)} {...props}>
    {children}
  </div>
);

const UsageRow = ({ label, tokens, className, ...props }: ComponentProps<"div"> & { label: string; tokens: number }) => {
  const locale = useLocale();
  return (
    <div className={cn("flex items-center justify-between text-xs", className)} {...props}>
      <span className="text-muted-foreground">{label}</span>
      <span>{formatTokens(locale, tokens)}</span>
    </div>
  );
};

export type ContextInputUsageProps = ComponentProps<"div">;

export const ContextInputUsage = ({ children, ...props }: ContextInputUsageProps) => {
  const { usage } = useContextValue();
  const { t } = useTranslation("chat");
  const inputTokens = usage?.inputTokens ?? 0;
  if (children) return children;
  if (!inputTokens) return null;
  return <UsageRow label={t(($) => $.context.input)} tokens={inputTokens} {...props} />;
};

export type ContextOutputUsageProps = ComponentProps<"div">;

export const ContextOutputUsage = ({ children, ...props }: ContextOutputUsageProps) => {
  const { usage } = useContextValue();
  const { t } = useTranslation("chat");
  const outputTokens = usage?.outputTokens ?? 0;
  if (children) return children;
  if (!outputTokens) return null;
  return <UsageRow label={t(($) => $.context.output)} tokens={outputTokens} {...props} />;
};

export type ContextCacheUsageProps = ComponentProps<"div">;

export const ContextCacheUsage = ({ children, ...props }: ContextCacheUsageProps) => {
  const { usage } = useContextValue();
  const { t } = useTranslation("chat");
  const cacheTokens = usage?.cachedInputTokens ?? 0;
  if (children) return children;
  if (!cacheTokens) return null;
  return <UsageRow label={t(($) => $.context.cache)} tokens={cacheTokens} {...props} />;
};
