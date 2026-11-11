// Shared empty state for lists with nothing to show.

import Icon from "@/components/Icon";

export default function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="card px-8 py-14 text-center">
      <span className="mx-auto inline-flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-surface text-ink-400">
        <Icon name="inbox" className="h-5 w-5" />
      </span>
      <h3 className="mt-4 font-semibold text-ink-900">{title}</h3>
      <p className="mx-auto mt-1 max-w-sm text-sm text-ink-600">{description}</p>
    </div>
  );
}
