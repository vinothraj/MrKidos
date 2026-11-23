"use client";

import { Button, EmptyState } from "@kidos/ui";
import { useEffect } from "react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main id="main" className="k-container k-main">
      <EmptyState
        title="Something went wrong"
        action={
          <Button onClick={reset}>Try again</Button>
        }
      >
        {error.digest ? `Reference: ${error.digest}` : "Please try again."}
      </EmptyState>
    </main>
  );
}
