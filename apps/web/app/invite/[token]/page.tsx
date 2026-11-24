import { InvitationScreen } from "./invitation-screen";

export const metadata = { title: "사맛디 초대", referrer: "no-referrer" as const };

export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <InvitationScreen key={token} token={token} />;
}
