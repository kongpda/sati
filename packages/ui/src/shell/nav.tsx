/** The side navigation: the product or project name, one link per page, the inbox count. */
export function Nav({
  pages,
  path,
  projectName,
  inbox,
  modal,
  go,
  onHelp,
}: {
  pages: readonly (readonly [string, string])[];
  path: string;
  projectName: string | undefined;
  inbox: number;
  modal: boolean;
  go: (href: string) => boolean;
  onHelp: () => void;
}) {
  return (
    <nav className="nav" inert={modal} data-modal={modal ? "" : undefined}>
      <p className="brand">{projectName ?? __PRODUCT_NAME__}</p>
      {pages.map(([href, label]) => (
        <a
          key={href}
          href={href}
          aria-current={path === href ? "page" : undefined}
          // The link keeps its name; the count is its description, read after it.
          aria-describedby={href === "/my-work" && inbox ? "inbox-count" : undefined}
          onClick={(e) => {
            e.preventDefault();
            go(href);
          }}
        >
          {label}
          {href === "/my-work" && inbox ? (
            <span className="nav-count" aria-hidden="true">
              {inbox > 99 ? "99+" : inbox}
            </span>
          ) : null}
        </a>
      ))}
      <button type="button" className="nav-help" onClick={onHelp}>
        Keyboard help
      </button>
      {inbox ? (
        <span id="inbox-count" hidden>
          {inbox === 1 ? "1 thing waits for you" : `${inbox} things wait for you`}
        </span>
      ) : null}
    </nav>
  );
}
