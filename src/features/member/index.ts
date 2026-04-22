// Story 2.1 — public barrel for the member feature.
// Downstream stories (2.2 create, 2.5 edit, 4.x transactions, 9.x dashboard)
// consume this barrel; direct imports into features/member/api/ or
// features/member/ui/ are forbidden by the `import/no-internal-modules`
// ESLint rule.

export { useMembers } from "./api/useMembers";
export { useCreateMember } from "./api/useCreateMember";
export { useImportMembers } from "./api/useImportMembers";
export { useMemberProfile } from "./api/useMemberProfile";
export { computeMemberStats } from "./api/computeMemberStats";
export { isContactPickerSupported } from "./api/contactsPickerSupport";
export {
  hasContactsConsent,
  grantContactsConsent,
  revokeContactsConsent,
} from "./api/contactsConsent";
export {
  MEMBERS_QUERY_KEY,
  MEMBER_HEADER_CTA_THRESHOLD,
  MEMBER_PROFILE_QUERY_KEY,
  createMemberInputSchema,
} from "./types";
export { MemberList } from "./ui/MemberList";
export { MemberCard } from "./ui/MemberCard";
export { MemberForm } from "./ui/MemberForm";
export { MemberProfile } from "./ui/MemberProfile";
export { ConsentScreen } from "./ui/ConsentScreen";
export { ContactsPickerStep, type PickedContact } from "./ui/ContactsPickerStep";
export { ImportProgressStep } from "./ui/ImportProgressStep";
export type {
  CreateMemberInput,
  DisplayStatus,
  DerivedStatus,
  MemberRow,
  MemberStats,
  MemberStatus,
  MemberWithMeta,
  CycleRow,
  CycleStatus,
  TransactionKind,
  TransactionRow,
  TransactionTimestamp,
} from "./types";
export type { ImportRow, ImportRowResult, ImportSummary } from "./api/useImportMembers";
export type { MemberProfileData } from "./api/useMemberProfile";
