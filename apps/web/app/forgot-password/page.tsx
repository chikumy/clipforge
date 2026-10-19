import { Field, Shell } from "@/lib/form";
import { requestPasswordReset } from "../actions";

export default function Forgot() {
  return (
    <Shell title="Reset your password">
      <form action={requestPasswordReset} className="space-y-4">
        <Field label="Email" name="email" type="email" autoComplete="email" />
        <button className="btn w-full">Send reset link</button>
      </form>
    </Shell>
  );
}
