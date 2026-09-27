import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

// A destructive alert with one link action at its right edge (Retry,
// Dismiss), as the settings lists show a load or row error.
export function ErrorActionAlert({
  message,
  actionLabel,
  onAction,
  className,
}: {
  message: string;
  actionLabel: string;
  onAction: () => void;
  className?: string;
}) {
  return (
    <Alert variant="destructive" className={className}>
      <AlertDescription className="flex items-start justify-between gap-3">
        <span className="min-w-0 break-words">{message}</span>
        <Button
          type="button"
          variant="link"
          size="sm"
          onClick={onAction}
          className="shrink-0 text-destructive"
        >
          {actionLabel}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
