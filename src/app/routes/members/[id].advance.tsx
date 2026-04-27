// Story 5.2 + 5.4 — /members/:id/advance route host.
//
// Story 5.2 mounted <AdvanceFlow> with no commit handler. Story 5.4
// wires the route to:
//   - useRecordAdvance — TanStack mutation around the record_advance RPC.
//   - showAdvanceToast — sonner-mounted ProgressiveToast in the
//     just-committed state with 5-s undo (mirror Stories 4.3 / 4.4).
//   - undoTransaction — Story 4.5 soft-undo (RPC-backed).
//   - typed-error toast.error mapping for each RecordAdvanceErrorCode.
// Navigates back to /members/:id on success.

import { useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";

import { useMemberProfile } from "@/features/member";
import { showAdvanceToast } from "@/features/transaction/api/showAdvanceToast";
import { undoTransaction } from "@/features/transaction/api/undoTransaction";
import { UndoTransactionError } from "@/features/transaction/api/undoTransactionError";
import { RecordAdvanceError, useRecordAdvance } from "@/features/transaction/api/useRecordAdvance";
import { AdvanceFlow, type AdvanceConfirmPayload } from "@/features/transaction/ui/AdvanceFlow";
import { useT } from "@/i18n/useT";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function MemberAdvanceRoute() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";

  if (!UUID_REGEX.test(id)) {
    return <Navigate to="/members" replace />;
  }
  return <AdvanceRouteBody memberId={id} />;
}

function AdvanceRouteBody({ memberId }: { memberId: string }): JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const profileQuery = useMemberProfile(memberId);
  const recordAdvance = useRecordAdvance();

  const data = profileQuery.data;

  const handleConfirm = async (payload: AdvanceConfirmPayload) => {
    if (!data?.member || !data.currentCycle) return;
    try {
      const txId = await recordAdvance.mutateAsync({
        memberId,
        cycleId: data.currentCycle.id,
        amount: payload.amount,
        cycleDay: data.stats.cycleDay,
        motive: payload.motive,
        // The Story 5.3 gate guarantees acknowledged === true at this
        // point (CTA is disabled otherwise); the literal narrows the
        // Zod schema's z.literal(true).
        saverAcknowledged: true,
      });
      showAdvanceToast({
        memberName: data.member.name,
        onUndo: async () => {
          try {
            await undoTransaction(txId, queryClient);
          } catch (err) {
            if (err instanceof UndoTransactionError) {
              toast.error(t(`transaction.error.${err.code}`));
            } else {
              toast.error(t("transaction.error.unknown"));
            }
          }
        },
      });
      navigate(`/members/${memberId}`);
    } catch (err) {
      if (err instanceof RecordAdvanceError) {
        toast.error(t(`advance.error.${err.code}`));
      } else {
        toast.error(t("advance.error.unknown"));
      }
    }
  };

  return <AdvanceFlow memberId={memberId} onConfirm={handleConfirm} />;
}
