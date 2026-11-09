import { ChevronDown, FolderPlus, Settings2, Terminal } from "lucide-react";
export function SandboxNav({
  repo,
  repos,
  onSelect,
  onManage,
  onCreate,
}: {
  repo?: string;
  repos: string[];
  onSelect: (repo: string) => void;
  onManage: (repo: string) => void;
  onCreate: () => void;
}) {
  return (
    <details className="sandbox-nav">
      <summary>
        <Terminal size={14} />
        <span>{repo || "沙箱"}</span>
        <ChevronDown size={12} />
      </summary>
      <div className="sandbox-menu">
        <button
          onClick={() => {
            if (repo) onManage(repo);
          }}
        >
          <Settings2 size={13} />
          管理当前沙箱
        </button>
        <details>
          <summary>
            切换沙箱
            <ChevronDown size={12} />
          </summary>
          <div className="sandbox-submenu">
            {repos.map((value) => (
              <button
                className={value === repo ? "active" : ""}
                key={value}
                onClick={(e) => {
                  onSelect(value);
                  const root = e.currentTarget.closest(
                    ".sandbox-nav",
                  ) as HTMLDetailsElement;
                  if (root) root.open = false;
                }}
              >
                {value}
              </button>
            ))}
          </div>
        </details>
        <button onClick={onCreate}>
          <FolderPlus size={13} />
          新建沙箱
        </button>
      </div>
    </details>
  );
}
