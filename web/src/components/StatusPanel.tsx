import type { PhoneRequestStatus } from "@arnifi/contracts";
import {
  BellRing,
  Check,
  CheckCheck,
  CircleAlert,
  Clock3,
  LoaderCircle,
  Radio,
  X,
} from "lucide-react";
import type { RequestUiState } from "../hooks/usePhoneRequest";

const statusContent: Record<
  RequestUiState,
  { eyebrow: string; title: string; detail: string }
> = {
  idle: {
    eyebrow: "Ready",
    title: "The phone is ready to be requested",
    detail: "One tap will alert the shared Samsung for 10 seconds.",
  },
  creating: {
    eyebrow: "Connecting",
    title: "Sending request…",
    detail: "We’re securely contacting the UAE phone.",
  },
  created: {
    eyebrow: "Preparing",
    title: "Preparing the alert…",
    detail: "Your request is being handed to Firebase.",
  },
  sent: {
    eyebrow: "Sent",
    title: "Request sent",
    detail: "Waiting for the phone to receive it…",
  },
  delivered: {
    eyebrow: "Delivered",
    title: "Phone received your request",
    detail: "The Samsung is alerting the person holding it.",
  },
  acknowledged: {
    eyebrow: "Acknowledged",
    title: "Someone has got the phone",
    detail: "Your request was acknowledged from the Samsung.",
  },
  cancelled: {
    eyebrow: "Cancelled",
    title: "Request cancelled",
    detail: "The matching alert has been asked to stop.",
  },
  expired: {
    eyebrow: "Expired",
    title: "No one acknowledged",
    detail: "You can ring the phone again.",
  },
  failed: {
    eyebrow: "Not sent",
    title: "Unable to send the request",
    detail: "Check your connection and try again.",
  },
};

function StatusIcon({ state }: { state: RequestUiState }) {
  if (state === "creating" || state === "created") return <LoaderCircle className="spin" />;
  if (state === "sent") return <Radio />;
  if (state === "delivered") return <Check />;
  if (state === "acknowledged") return <CheckCheck />;
  if (state === "cancelled") return <X />;
  if (state === "expired") return <Clock3 />;
  if (state === "failed") return <CircleAlert />;
  return <BellRing />;
}

export function StatusPanel({
  state,
  deliveryDelayed,
}: {
  state: RequestUiState;
  deliveryDelayed: boolean;
}) {
  const content = statusContent[state];
  const activeIndex = ["creating", "created", "sent", "delivered", "acknowledged"].indexOf(state);
  const isProgress = activeIndex >= 0;

  return (
    <section className={`status-panel status-${state}`} aria-live="polite" aria-busy={state === "creating"}>
      <div className="status-heading">
        <span className="status-icon"><StatusIcon state={state} /></span>
        <div>
          <p className="eyebrow">{content.eyebrow}</p>
          <h2>{content.title}</h2>
        </div>
      </div>
      <p className="status-detail">
        {deliveryDelayed && state === "sent"
          ? "Delivery could not yet be confirmed. The phone may be offline."
          : content.detail}
      </p>
      {isProgress && (
        <ol className="progress-track" aria-label="Request progress">
          {[
            ["Sent", 2],
            ["Phone received", 3],
            ["Acknowledged", 4],
          ].map(([label, threshold]) => (
            <li key={label as string} className={activeIndex >= (threshold as number) ? "complete" : ""}>
              <span aria-hidden="true" />
              {label as string}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function isTerminalState(state: RequestUiState): state is PhoneRequestStatus {
  return ["acknowledged", "cancelled", "expired", "failed"].includes(state);
}

