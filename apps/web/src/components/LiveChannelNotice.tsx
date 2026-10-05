// The live channel is down (#590): what the chat shows instead of loading
// forever, and above a loaded conversation once the channel drops.

import { useTranslation } from "react-i18next";
import { displayError } from "../errors";
import type { LiveChannel } from "../lib/use-live-channel";
import { Button } from "@/components/ui/button";

export default function LiveChannelNotice({
  channel,
  onReconnect,
  className = "",
}: {
  channel: LiveChannel;
  onReconnect: () => void;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const reason = channel.error === undefined ? t(($) => $.live_channel.reason_unknown) : displayError(channel.error);
  return (
    <div
      role="status"
      className={`flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[12px] text-[var(--color-text-muted)] ${className}`}
    >
      <span className="flex flex-1 flex-col leading-[1.5]">
        <span>{channel.status === "closed" ? t(($) => $.live_channel.closed) : t(($) => $.live_channel.reconnecting)}</span>
        <span className="text-[var(--color-text-dim)]">{t(($) => $.live_channel.reason, { reason })}</span>
      </span>
      <Button variant="outline" size="xs" className="shrink-0" onClick={onReconnect}>
        {t(($) => $.live_channel.reconnect)}
      </Button>
    </div>
  );
}
