import { ButtonLink, EmptyState } from "@kidos/ui";
import { Artwork } from "@/components/artwork";

export default function NotFound() {
  return (
    <main id="main" className="k-container k-main">
      <EmptyState title="We couldn't find that page" art={<Artwork slot="explore" />} action={<ButtonLink href="/">Go to the home page</ButtonLink>}>
        The link may be old or mistyped.
      </EmptyState>
    </main>
  );
}
