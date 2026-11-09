import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  Paperclip,
  ArrowUp,
  Check,
  Code2,
  Command,
  CornerDownLeft,
  FolderPlus,
  FileText,
  ChevronUp,
  Languages,
  LogOut,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  api,
  ArtifactLink,
  Busy,
  CopyButton,
  JsonView,
  Modal,
  Picker,
  RichText,
} from "./ui";
import { AssetRail, AssetPreview, uploadFile } from "./Assets";
import { Conversation, type ConversationHandle } from "./Conversation";
import { ActivityLine } from "./ActivityLine";
import { PerformanceBar } from "./PerformanceBar";
import { useDraft } from "./useDraft";
import { useDrawerFocus, useMediaQuery, usePortraitSwipe } from "./useDrawer";
import type { Activity } from "../shared/activity";
import { RichContext } from "./rich-context";
import { QuotaWidget } from "./QuotaWidget";
import { ControlsPanel } from "./ControlsPanel";
import { SandboxNav } from "./SandboxNav";
import { ReportsPage } from "./Reports";
import { ThemeToggle } from "./ThemeToggle";
import { useRecovery, disconnected } from "./useRecovery";
const ShellPanel = lazy(() =>
  import("./ShellPanel").then((module) => ({ default: module.ShellPanel })),
);
import { ConnectionForm, SandboxManager } from "./Manage";
import { SetupWizard } from "./SetupWizard";
import type {
  Asset,
  TraceBlock,
  SessionSnapshot,
  DownstreamMode,
  Capabilities,
  Effort,
  Finding,
  Message,
  PermissionMode,
  PublicConfig,
  Review,
  ReviewMode,
  RunEvent,
  Session,
  Strategy,
} from "../shared/types";
type View = "zh" | "both" | "original";
const strategies: Record<Strategy, string> = {
  pending: "选择处理方式",
  placeholder: "占位符",
  env: "ENV",
  pass: "原样透传",
  rewrite: "返回重写",
};
const permissionNames: Record<PermissionMode, string> = {
  auto: "自动审核",
  default: "逐次确认",
  acceptEdits: "自动编辑",
  plan: "仅规划",
  dontAsk: "拒绝未授权",
  bypassPermissions: "完全放行（沙箱）",
};
const shortcuts = [
  { name: "usage", description: "当前会话用量" },
  { name: "context", description: "上下文占用" },
  { name: "mcp", description: "MCP 服务与技能" },
  { name: "tasks", description: "后台任务与子代理" },
  { name: "model", description: "切换模型" },
  { name: "compact", description: "压缩上下文" },
  { name: "clear", description: "当前沙箱新会话" },
];

export function App() {
  const [booting, setBooting] = useState(true),
    [setup, setSetup] = useState(false),
    [locked, setLocked] = useState(false),
    [password, setPassword] = useState(""),
    [config, setConfig] = useState<PublicConfig>();
  const [sessions, setSessions] = useState<Session[]>([]),
    [current, setCurrent] = useState<Session>(),
    [messages, setMessages] = useState<Message[]>([]),
    [caps, setCaps] = useState<Capabilities>(),
    [capError, setCapError] = useState(""),
    [capLoading, setCapLoading] = useState(false);
  const [activities, setActivities] = useState<Activity[]>([]),
    [activityConnection, setActivityConnection] = useState<
      "connecting" | "open" | "reconnecting" | "closed"
    >("connecting");
  const [blocks, setBlocks] = useState<TraceBlock[]>([]),
    [assets, setAssets] = useState<Asset[]>([]),
    [previewId, setPreviewId] = useState(""),
    [uploading, setUploading] = useState(false),
    [dragging, setDragging] = useState(false),
    [referencesOpen, setReferencesOpen] = useState(false),
    [downstream, setDownstream] = useState<DownstreamMode>(
      (localStorage.getItem("folio-downstream-default-v2")
        ? (localStorage.getItem("folio-downstream") as DownstreamMode)
        : localStorage.getItem("folio-downstream") === "manual"
          ? "manual"
          : "messages") || "messages",
    );
  const sessionSource = useRef<EventSource | null>(null),
    fileInput = useRef<HTMLInputElement>(null);
  const {
    prompt,
    attached,
    attachmentRef,
    setPrompt,
    setAttached,
    selectDraft,
    removeDraft,
    clearSubmitted,
  } = useDraft();
  const [pending, setPending] = useState(""),
    [toast, setToast] = useState(""),
    [fatal, setFatal] = useState(""),
    [review, setReview] = useState<Review>(),
    [selection, setSelection] = useState<{ start: number; end: number }>(),
    [focused, setFocused] = useState("");
  const [model, setModel] = useState(
      localStorage.getItem("folio-model") || "default",
    ),
    [effort, setEffort] = useState<Effort>(
      (localStorage.getItem("folio-effort") as Effort) || "default",
    ),
    [permission, setPermission] = useState<PermissionMode>(
      (localStorage.getItem("folio-permission") as PermissionMode) || "auto",
    ),
    [reviewMode, setReviewMode] = useState<ReviewMode>(
      (localStorage.getItem("folio-review") as ReviewMode) || "automatic",
    ),
    [view, setView] = useState<View>(
      (localStorage.getItem("yj-view") as View) || "both",
    );
  const [running, setRunning] = useState(false),
    [runId, setRunId] = useState(""),
    [output, setOutput] = useState(""),
    [completedRunId, setCompletedRunId] = useState(""),
    [events, setEvents] = useState<RunEvent[]>([]),
    [activity, setActivity] = useState(""),
    [answered, setAnswered] = useState<string[]>([]);
  const [sidebar, setSidebar] = useState(false),
    [shellOpen, setShellOpen] = useState(false),
    [accountOpen, setAccountOpen] = useState(false),
    [manageRepo, setManageRepo] = useState(""),
    [settings, setSettings] = useState(false),
    [newSandbox, setNewSandbox] = useState(false),
    [repoDraft, setRepoDraft] = useState(""),
    [sdkOpen, setSdkOpen] = useState(false),
    [controlResult, setControlResult] = useState<{
      method: string;
      result: unknown;
    }>(),
    [usageScope, setUsageScope] = useState<"session" | "sandbox">("session"),
    [sdkTab, setSdkTab] = useState<
      "usage" | "context" | "extensions" | "tasks" | "files" | "sdk"
    >("usage"),
    [editSession, setEditSession] = useState<Session>(),
    [title, setTitle] = useState(""),
    [query, setQuery] = useState(""),
    [commandsOpen, setCommandsOpen] = useState(false),
    [candidateIndex, setCandidateIndex] = useState(-1),
    [composerOptions, setComposerOptions] = useState(false);
  const narrow = useMediaQuery("(max-width: 850px)");
  const portrait = useMediaQuery("(orientation: portrait)");
  const drawerOpen = narrow && sidebar;
  const drawer = useDrawerFocus(drawerOpen);
  const swipe = usePortraitSwipe(
    narrow && portrait && !drawerOpen && !composerOptions,
    () => setSidebar(true),
  );
  useEffect(() => {
    if (!narrow) {
      setSidebar(false);
      setComposerOptions(false);
    }
  }, [narrow]);
  const source = useRef<EventSource | null>(null),
    active = useRef(""),
    conversation = useRef<ConversationHandle>(null),
    original = useRef<HTMLDivElement>(null),
    composer = useRef<HTMLTextAreaElement>(null),
    composerMore = useRef<HTMLButtonElement>(null),
    initialized = useRef(false),
    restoreComposer = useRef(false),
    focusedReview = useRef("");
  const reviewFocusKey = review ? review.id + ":" + review.status : "";
  const focusReview = useCallback(
    (element: HTMLElement | null) => {
      if (!element || focusedReview.current === reviewFocusKey) return;
      focusedReview.current = reviewFocusKey;
      element.focus({ preventScroll: true });
    },
    [reviewFocusKey],
  );
  useLayoutEffect(() => {
    if (review) return;
    focusedReview.current = "";
    if (restoreComposer.current) {
      restoreComposer.current = false;
      composer.current?.focus({ preventScroll: true });
    }
  }, [review]);
  const notify = useCallback((text: string) => setToast(text), []);
  const openAsset = useCallback((a: Asset) => setPreviewId(a.id), []);
  const onAsset = useCallback(
    (a: Asset) => setAssets((list) => upsert(list, a)),
    [],
  );
  const recovery = useRecovery({
    canReload:
      !booting &&
      !setup &&
      !locked &&
      !prompt &&
      !review &&
      !attached.length &&
      !uploading &&
      !pending &&
      !running &&
      !shellOpen,
    onLocked: () => {
      source.current?.close();
      sessionSource.current?.close();
      setLocked(true);
      setRunning(false);
    },
    onRecovered: async (restarted) => {
      if (!current) {
        if (!location.pathname.startsWith("/report") && !locked && !setup)
          await init();
        return;
      }
      const detail = await api<SessionSnapshot>(
        `/sessions/${current.id}?tail=1`,
      );
      if (active.current !== current.id) return;
      setCurrent(detail.session);
      subscribeSession(current.id);
      if (detail.runId) watch(detail.runId, current.id);
      else {
        source.current?.close();
        setRunning(false);
        setRunId("");
        setEvents([]);
        setOutput("");
      }
      if (restarted && review) {
        setPrompt(review.original);
        setReview(undefined);
        notify("连接已恢复，请重新检查尚未发送的输入。");
      }
      await refreshSessions();
    },
  });
  const richContext = useMemo(
    () => ({ sessionId: current?.id, assets, onAsset, onError: notify }),
    [current?.id, assets, onAsset, notify],
  );
  const deferredOutput = useDeferredValue(output);
  async function action(name: string, fn: () => Promise<void>) {
    setPending(name);
    try {
      await fn();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setPending("");
    }
  }
  const options = () => ({
    model,
    permissionMode: permission,
    effort,
    downstreamMode: downstream,
  });
  const refreshSessions = async () => {
    const result = await api<Session[]>("/sessions");
    setSessions(result);
    return result;
  };
  async function refreshCapabilities(session: Session, force = false) {
    setCapLoading(true);
    setCapError("");
    try {
      const result = await api<Capabilities>(
        `/sessions/${session.id}/capabilities${force ? "?refresh=1" : ""}`,
      );
      if (active.current !== session.id) return;
      setCaps(result);
      if (
        !result.models.some(
          (m) => m.value === model || m.resolvedModel === model,
        )
      )
        setModel(result.models[0]?.value || "default");
    } catch (e) {
      if (active.current === session.id) setCapError((e as Error).message);
    } finally {
      if (active.current === session.id) setCapLoading(false);
    }
  }
  function subscribeSession(sessionId: string) {
    sessionSource.current?.close();
    const es = new EventSource(
      `/api/sessions/${sessionId}/events?stream=delta`,
    );
    sessionSource.current = es;
    es.onopen = () => {
      if (active.current === sessionId) setActivityConnection("open");
    };
    es.onerror = () => {
      if (sessionSource.current !== es) return;
      disconnected();
      if (active.current === sessionId)
        setActivityConnection(
          es.readyState === EventSource.CLOSED ? "closed" : "reconnecting",
        );
    };
    es.addEventListener("snapshot", (event) => {
      if (active.current !== sessionId) return;
      const data = JSON.parse(event.data);
      setMessages(data.messages);
      setBlocks(data.blocks);
      setAssets(data.assets);
      setActivities(data.activities || []);
      if (data.live !== undefined) setOutput(data.live?.text || "");
    });
    es.addEventListener("change", (event) => {
      if (active.current !== sessionId) return;
      const data = JSON.parse(event.data);
      if (data.activities) setActivities(data.activities);
      if (data.session) setCurrent(data.session);
      if (data.message) setMessages((list) => upsert(list, data.message));
      if (data.block) setBlocks((list) => upsert(list, data.block));
      if (data.asset) setAssets((list) => upsert(list, data.asset));
      if (data.live !== undefined)
        setOutput((previous) =>
          typeof data.live?.delta === "string"
            ? previous + data.live.delta
            : data.live?.text || "",
        );
    });
  }
  async function openSession(session: Session) {
    localStorage.setItem("folio-current-session", session.id);
    source.current?.close();
    sessionSource.current?.close();
    active.current = session.id;
    setActivities([]);
    setCompletedRunId("");
    setActivityConnection("connecting");
    setBlocks([]);
    setAssets([]);
    const restoredAttachments = selectDraft(session.id);
    setPreviewId("");
    setCurrent(session);
    setMessages([]);
    setReview(undefined);
    setCommandsOpen(false);
    setReferencesOpen(false);
    setCandidateIndex(-1);
    setEvents([]);
    setOutput("");
    setCaps(undefined);
    setCapError("");
    setRunning(false);
    setRunId("");
    setActivity("");
    setSidebar(false);
    const detail = await api<SessionSnapshot>(`/sessions/${session.id}`);
    if (active.current !== session.id) return;
    setCurrent(detail.session);
    setMessages(detail.messages);
    setActivities(detail.activities || []);
    setBlocks(detail.blocks);
    setAssets(detail.assets);
    if (restoredAttachments.length) {
      const available = new Set(detail.assets.map((asset) => asset.id));
      const missing = new Set(
        restoredAttachments.filter((id) => !available.has(id)),
      );
      if (missing.size)
        setAttached(attachmentRef.current.filter((id) => !missing.has(id)));
    }
    if (detail.session.downstreamMode)
      setDownstream(detail.session.downstreamMode);
    subscribeSession(session.id);
    if (detail.session.model) setModel(detail.session.model);
    if (detail.session.effort) setEffort(detail.session.effort);
    if (detail.session.permissionMode)
      setPermission(detail.session.permissionMode);
    if (detail.runId) watch(detail.runId, session.id);
    void refreshCapabilities(detail.session);
  }
  async function init() {
    setBooting(true);
    setFatal("");
    try {
      const auth = await api<{
        required: boolean;
        loggedIn: boolean;
        setupRequired: boolean;
      }>("/auth");
      setSetup(auth.setupRequired);
      if (auth.setupRequired) return;
      setLocked(auth.required && !auth.loggedIn);
      if (auth.required && !auth.loggedIn) return;
      const configuration = await api<PublicConfig>("/config");
      setConfig(configuration);
      if (
        location.pathname === "/report" ||
        location.pathname.startsWith("/report/")
      )
        return;
      let list = await refreshSessions();
      if (!list.length) {
        const created = await api<Session>("/sessions", {
          repo: configuration.defaultRepo,
        });
        list = [created];
        setSessions(list);
      }
      await openSession(
        list.find(
          (session) =>
            session.id === localStorage.getItem("folio-current-session"),
        ) || list[0],
      );
    } catch (e) {
      setFatal((e as Error).message);
    } finally {
      setBooting(false);
    }
  }
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      void init();
    }
    return () => {};
  }, []);
  useEffect(
    () => () => {
      source.current?.close();
      sessionSource.current?.close();
    },
    [],
  );
  useEffect(() => {
    localStorage.setItem("folio-model", model);
    localStorage.setItem("folio-effort", effort);
    localStorage.setItem("folio-permission", permission);
    localStorage.setItem("folio-review", reviewMode);
    localStorage.setItem("yj-view", view);
    localStorage.setItem("folio-downstream", downstream);
    localStorage.setItem("folio-downstream-default-v2", "1");
  }, [model, effort, permission, reviewMode, view, downstream]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (review) conversation.current?.follow();
  }, [review?.id, review?.status]);
  function watch(id: string, sessionId: string) {
    source.current?.close();
    setRunId(id);
    setCompletedRunId("");
    setActivity("等待模型响应");
    setRunning(true);
    setEvents([]);
    setOutput("");
    setAnswered([]);
    const es = new EventSource(`/api/runs/${id}/events`);
    source.current = es;
    es.onmessage = (event) => {
      if (active.current !== sessionId) {
        es.close();
        return;
      }
      const value: RunEvent = JSON.parse(event.data);
      if (["permission", "dialog", "task"].includes(value.type))
        setEvents((list) =>
          list.some((e) => e.seq === value.seq) ? list : [...list, value],
        );

      if (value.type === "status") setActivity(value.text || "");
      if (value.type === "user") {
        const message = value.data as Message;
        setMessages((list) =>
          list.some((m) => m.id === message.id) ? list : [...list, message],
        );
      }
      if (value.type === "translation") {
        const data = value.data as { message?: Message } | undefined;
        if (data?.message) setMessages((list) => upsert(list, data.message!));
        setOutput("");
      }
      if (value.type === "notification" && (value.data as any)?.answered)
        setAnswered((list) => [...list, (value.data as any).answered]);
      if (value.type === "notification" && (value.data as any)?.interaction) {
        const update = (value.data as any).interaction;
        setEvents((list) =>
          list.map((event) =>
            (event.type === "permission" || event.type === "dialog") &&
            (event.data as any)?.id === update.id
              ? { ...event, data: { ...(event.data as object), ...update } }
              : event,
          ),
        );
      }
      if (value.type === "usage")
        setCurrent((session) =>
          session
            ? { ...session, usage: value.data as Record<string, unknown> }
            : session,
        );
      if (value.type === "done" || value.type === "error") {
        es.close();
        setCompletedRunId(id);
        setRunning(false);
        setRunId("");
        setOutput("");
        setActivity(value.text || "");
        if (value.type === "error") notify(value.text || "执行失败");
        void api<{ session: Session; messages: Message[] }>(
          `/sessions/${sessionId}?tail=1`,
        ).then((result) => {
          if (active.current === sessionId) {
            setMessages((list) =>
              result.messages.reduce((all, m) => upsert(all, m), list),
            );
            setCurrent(result.session);
          }
        });
        void refreshSessions();
      }
    };
    es.onerror = () => {
      if (source.current !== es) return;
      disconnected();
      if (es.readyState === EventSource.CLOSED) {
        setRunning(false);
        setActivity("连接已断开，正在自动恢复");
      }
    };
  }
  async function createSession(
    repo = current?.repo || config?.defaultRepo || "my-project",
  ) {
    await action("new", async () => {
      const session = await api<Session>("/sessions", { repo });
      await refreshSessions();
      await openSession(session);
    });
  }
  const showSdk = (
    tab: typeof sdkTab,
    scope: "session" | "sandbox" = "session",
  ) => {
    setUsageScope(scope);
    setControlResult(undefined);
    setSdkTab(tab);
    setSdkOpen(true);
  };
  async function addFiles(files: globalThis.File[]) {
    if (!current || uploading || review) return;
    const sessionId = current.id;
    if (attachmentRef.current.length + files.length > 12) {
      notify("每条消息最多 12 个附件");
      return;
    }
    setUploading(true);
    try {
      for (const file of files) {
        if (file.size > 25 * 1024 * 1024) {
          notify(`${file.name} 超过 25 MB`);
          continue;
        }
        const asset = await uploadFile(sessionId, file);
        if (active.current !== sessionId) break;
        setAssets((list) => upsert(list, asset));
        attachmentRef.current = [...attachmentRef.current, asset.id];
        setAttached(attachmentRef.current);
        if (asset.approval === "pending") setPreviewId(asset.id);
      }
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setUploading(false);
    }
  }
  const referenceAsset = useCallback(
    (a: Asset) => {
      if (!attachmentRef.current.includes(a.id)) {
        if (attachmentRef.current.length >= 12) {
          notify("每条消息最多 12 个附件");
          return;
        }
        attachmentRef.current = [...attachmentRef.current, a.id];
        setAttached(attachmentRef.current);
      }
      setPrompt((text) => text.replace(/@[^@\s]*$/, "") + `@[${a.name}] `);
      setReferencesOpen(false);
      composer.current?.focus();
    },
    [notify, attachmentRef, setAttached, setPrompt],
  );
  async function send() {
    if (!current || (!prompt.trim() && !attached.length) || uploading) return;
    if (
      assets.some((a) => attached.includes(a.id) && a.approval === "pending")
    ) {
      setPreviewId(
        assets.find((a) => attached.includes(a.id) && a.approval === "pending")!
          .id,
      );
      return;
    }
    const text = prompt.trim();
    const sessionId = current.id;
    const local: Record<string, typeof sdkTab> = {
      "/usage": "usage",
      "/cost": "usage",
      "/stats": "usage",
      "/context": "context",
      "/mcp": "extensions",
      "/skills": "extensions",
      "/agents": "extensions",
      "/tasks": "tasks",
    };
    if (local[text]) {
      showSdk(local[text]);
      clearSubmitted(sessionId, text, attached);
      return;
    }
    await action("send", async () => {
      conversation.current?.follow();
      setActivity("正在检查输入");
      const result = await api<{
        review?: Review;
        runId?: string;
        control?: string;
        result?: unknown;
        session?: Session;
      }>("/messages", {
        sessionId,
        prompt: text,
        mode: reviewMode,
        steering: running,
        attachments: attached,
        ...options(),
      });
      if (!result.review) clearSubmitted(sessionId, text, attached);
      if (active.current !== sessionId) return;
      setCommandsOpen(false);
      setReferencesOpen(false);
      if (result.review) {
        setReview(result.review);
        setFocused(result.review.findings[0]?.id || "");
        setActivity("等待隐私处理");
        return;
      }
      if (result.session) {
        await refreshSessions();
        await openSession(result.session);
        return;
      }
      if (result.runId) {
        const detail = await api<{ messages: Message[] }>(
          `/sessions/${sessionId}?tail=1`,
        );
        if (active.current !== sessionId) return;
        setMessages((list) =>
          detail.messages.reduce((all, m) => upsert(all, m), list),
        );
        if (result.runId !== runId) watch(result.runId, sessionId);
        else setActivity("插话已排队");
      } else if (result.control) {
        setControlResult({ method: result.control, result: result.result });
        setSdkTab("sdk");
        setSdkOpen(true);
        if (result.control === "setModel") setModel(text.split(/\s+/)[1]);
        void refreshCapabilities(current);
      }
    });
  }
  function returnToDraft() {
    if (!review) return;
    setPrompt(review.original);
    setAttached(review.attachments || []);
    restoreComposer.current = true;
    setSelection(undefined);
    setReview(undefined);
  }
  async function decide(id: string, strategy: Strategy) {
    if (!review) return;
    if (strategy === "rewrite") {
      returnToDraft();
      return;
    }
    await action("decision", async () => {
      const updated = await api<Review>(
        `/reviews/${review.id}`,
        { decisions: [{ id, strategy }] },
        "PATCH",
      );
      if (active.current === review.sessionId) setReview(updated);
    });
  }
  async function markSelection() {
    if (!review || !selection) return;
    await action("mark", async () => {
      const updated = await api<Review>(
        `/reviews/${review.id}`,
        { manual: selection },
        "PATCH",
      );
      if (active.current !== review.sessionId) return;
      setReview(updated);
      setSelection(undefined);
      window.getSelection()?.removeAllRanges();
    });
  }
  function captureSelection() {
    const selected = window.getSelection(),
      element = original.current;
    if (
      !selected?.rangeCount ||
      selected.isCollapsed ||
      !element?.contains(selected.anchorNode) ||
      !element.contains(selected.focusNode)
    ) {
      setSelection(undefined);
      return;
    }
    const range = selected.getRangeAt(0),
      prefix = range.cloneRange();
    prefix.selectNodeContents(element);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    setSelection({ start, end: start + range.toString().length });
  }
  async function continueReview() {
    if (!review || !current) return;
    await action("review", async () => {
      if (review.status !== "prepared") {
        setActivity(review.mode === "direct" ? "正在传递" : "正在翻译输入");
        const prepared = await api<Review>(`/reviews/${review.id}/prepare`, {});
        if (active.current !== review.sessionId) return;
        setReview(prepared);
        if (review.mode === "manual") {
          setActivity("等待英文确认");
          return;
        }
      }
      setActivity("正在传递");
      const response = await api<{ id: string }>("/runs", {
        reviewId: review.id,
        ...options(),
      });
      clearSubmitted(
        review.sessionId,
        review.original,
        review.attachments || [],
      );
      if (active.current !== review.sessionId) return;
      setReview(undefined);
      const detail = await api<{ messages: Message[] }>(
        `/sessions/${current.id}?tail=1`,
      );
      setMessages((list) =>
        detail.messages.reduce((all, m) => upsert(all, m), list),
      );
      if (active.current !== review.sessionId) return;
      if (response.id !== runId) watch(response.id, current.id);
      else setActivity("插话已排队");
    });
  }
  const unresolved =
    review?.findings.filter(
      (f) => f.strategy === "pending" || f.strategy === "rewrite",
    ).length || 0;
  const selectedModel = caps?.models.find(
    (m) => m.value === model || m.resolvedModel === model,
  );
  const effortOptions = [
    { value: "default", label: "思考：默认" },
    { value: "off", label: "思考：关闭" },
    ...(selectedModel?.supportedEffortLevels || []).map((level) => ({
      value: level,
      label: `思考：${level}`,
    })),
  ];
  const modelOptions = caps?.models.map((value) => ({
    value: value.value,
    label: value.displayName,
  })) || [{ value: model, label: capLoading ? "模型加载中" : model }];
  const advancedComposerControls = (
    <>
      <Picker
        label="主模型思考强度"
        value={effort}
        options={effortOptions}
        disabled={!!pending}
        onChange={(value) => {
          setEffort(value as Effort);
          if (running && current)
            void action("effort", async () => {
              await api(`/sessions/${current.id}/control`, {
                method:
                  value === "off"
                    ? "setMaxThinkingTokens"
                    : "applyFlagSettings",
                args:
                  value === "off"
                    ? [0]
                    : [
                        {
                          effortLevel: value === "default" ? null : value,
                        },
                      ],
              });
            });
        }}
      />
      <Picker
        label="上行发送方式"
        value={reviewMode}
        options={[
          { value: "automatic", label: "上行：静默翻译" },
          { value: "manual", label: "上行：逐步确认" },
          { value: "direct", label: "上行：直接发送" },
        ]}
        onChange={(value) => setReviewMode(value as ReviewMode)}
        disabled={!!review}
      />
      <Picker
        label="下行翻译方式"
        value={downstream}
        options={[
          { value: "all", label: "下行：翻译全部" },
          { value: "messages", label: "下行：仅翻译回复" },
          { value: "manual", label: "下行：手动翻译" },
        ]}
        onChange={(value) => {
          setDownstream(value as DownstreamMode);
          if (current)
            void api(`/sessions/${current.id}/preferences`, {
              downstreamMode: value,
            }).catch((e) => notify(e.message));
        }}
      />
    </>
  );
  const commandList = [
    ...new Map(
      [...shortcuts, ...(caps?.commands || [])].map((command) => [
        command.name,
        command,
      ]),
    ).values(),
  ]
    .filter((command) =>
      command.name.includes(prompt.slice(1).trim().split(" ")[0]),
    )
    .slice(0, 12);
  const candidates =
    commandsOpen && /^\/[^\s]*$/.test(prompt)
      ? commandList.map((command) => ({
          id: command.name,
          label: "/" + command.name,
          description: command.description,
          select: () => {
            setPrompt("/" + command.name + " ");
            setCommandsOpen(false);
            composer.current?.focus();
          },
        }))
      : referencesOpen
        ? assets
            .filter(
              (asset) =>
                asset.origin === "upload" &&
                asset.name
                  .toLowerCase()
                  .includes(
                    (prompt.match(/@([^@\s]*)$/)?.[1] || "").toLowerCase(),
                  ),
            )
            .slice(-8)
            .map((asset) => ({
              id: asset.id,
              label: "@" + asset.name,
              description: asset.kind,
              select: () => referenceAsset(asset),
            }))
        : [];
  useEffect(() => {
    if (candidateIndex >= 0)
      document
        .getElementById("candidate-" + candidateIndex)
        ?.scrollIntoView({ block: "nearest" });
  }, [candidateIndex]);
  const repos = [
    ...new Set(
      [config?.defaultRepo, ...sessions.map((session) => session.repo)].filter(
        Boolean,
      ),
    ),
  ] as string[];
  const tasks = events.filter((e) => e.type === "task").map((e) => e.data);
  const emptySession = messages.length === 0 && !review && !running;
  if (booting)
    return (
      <div className="gate">
        <span className="wordmark">Folio</span>
        <Busy />
      </div>
    );
  if (setup) return <SetupWizard onComplete={() => void init()} />;
  if (locked)
    return (
      <div className="gate">
        <form
          className="form login"
          onSubmit={(e) => {
            e.preventDefault();
            void action("login", async () => {
              await api("/auth", { password });
              setPassword("");
              await init();
            });
          }}
        >
          <div className="login-heading">
            <span className="wordmark">Folio</span>
            <ThemeToggle />
          </div>
          <label className="field">
            访问密码
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button className="primary" disabled={!!pending}>
            {pending && <Busy />}登录
          </button>
          {toast && <p className="error">{toast}</p>}
        </form>
      </div>
    );
  if (fatal)
    return (
      <div className="gate">
        <p className="error">{fatal}</p>
        <button className="secondary" onClick={() => void init()}>
          重新连接
        </button>
      </div>
    );
  const connectionNotice =
    recovery.state === "reconnecting" || recovery.update ? (
      <div className="connection-notice" role="status">
        <Busy />
        <span>
          {recovery.state === "reconnecting"
            ? "连接中断，正在自动重连…"
            : "新版本已就绪，当前输入处理完成后自动刷新。"}
        </span>
        <button onClick={recovery.retry}>立即重试</button>
      </div>
    ) : null;
  if (
    location.pathname === "/report" ||
    location.pathname.startsWith("/report/")
  )
    return (
      <>
        {connectionNotice}
        <ReportsPage />
      </>
    );
  return (
    <ArtifactLink.Provider value={setPreviewId}>
      <RichContext.Provider value={richContext}>
        <div className="app-shell" {...swipe}>
          {drawerOpen && (
            <button
              className="nav-scrim"
              aria-label="收起导航"
              tabIndex={-1}
              onClick={() => setSidebar(false)}
            />
          )}
          <aside
            className={`sidebar ${drawerOpen ? "open" : ""}`}
            id="workspace-navigation"
            aria-label="会话与沙箱导航"
            role={drawerOpen ? "dialog" : undefined}
            aria-modal={drawerOpen || undefined}
            inert={narrow && !drawerOpen}
            onKeyDown={(event) => {
              if (!drawerOpen) return;
              if (event.key === "Escape") {
                event.preventDefault();
                setSidebar(false);
              }
              if (event.key !== "Tab") return;
              const focusable = [
                ...event.currentTarget.querySelectorAll<HTMLElement>(
                  "button:not(:disabled), input:not(:disabled), a[href], summary",
                ),
              ].filter(
                (item) =>
                  item.tabIndex >= 0 &&
                  item.getClientRects().length &&
                  !item.closest("[inert]"),
              );
              const first = focusable[0],
                last = focusable.at(-1);
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }}
          >
            <div className="sidebar-brand">
              <span className="wordmark">Folio</span>
              <ThemeToggle />
              <button
                className="icon mobile-only"
                aria-label="关闭导航"
                ref={drawer.close}
                onClick={() => setSidebar(false)}
              >
                <X size={17} />
              </button>
            </div>
            <SandboxNav
              repo={current?.repo}
              repos={repos}
              onManage={setManageRepo}
              onCreate={() => {
                setRepoDraft("");
                setNewSandbox(true);
              }}
              onSelect={(repo) => {
                const found = sessions.find((s) => s.repo === repo);
                if (found) void action("open", () => openSession(found));
                else void createSession(repo);
              }}
            />
            <button
              className="new-session"
              disabled={pending === "new"}
              onClick={() => void createSession()}
            >
              <Plus size={15} />
              新会话
            </button>
            <div className="nav-heading">
              <span>会话</span>
              <span>
                {sessions.filter((s) => s.repo === current?.repo).length}
              </span>
            </div>
            <label className="session-search">
              <Search size={13} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="搜索会话"
                placeholder="搜索"
              />
            </label>
            <div className="session-list">
              {sessions
                .filter(
                  (s) => s.repo === current?.repo && s.title.includes(query),
                )
                .map((session) => (
                  <div
                    className={`session-item ${session.id === current?.id ? "active" : ""}`}
                    key={session.id}
                  >
                    <button
                      onClick={() =>
                        void action("open", () => openSession(session))
                      }
                    >
                      <MessageSquare size={13} />
                      <span>{session.title}</span>
                    </button>
                    <button
                      className="icon"
                      aria-label={`管理会话 ${session.title}`}
                      onClick={() => {
                        setEditSession(session);
                        setTitle(session.title);
                      }}
                    >
                      <MoreHorizontal size={13} />
                    </button>
                  </div>
                ))}
            </div>
            <div
              className={`sidebar-bottom account-menu ${accountOpen ? "expanded" : ""}`}
              onMouseEnter={() => setAccountOpen(true)}
              onMouseLeave={() => setAccountOpen(false)}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget))
                  setAccountOpen(false);
              }}
            >
              <button
                className="account-trigger"
                aria-expanded={accountOpen}
                onClick={(event) =>
                  setAccountOpen((value) =>
                    event.detail === 0 ? !value : true,
                  )
                }
              >
                <Settings2 size={14} />
                <span>用量与设置</span>
                <ChevronUp size={12} />
              </button>
              <div className="account-popover" inert={!accountOpen}>
                <QuotaWidget
                  sessionId={current?.id}
                  repo={current?.repo}
                  usage={current?.usage}
                  onOpen={() => showSdk("usage", "sandbox")}
                />
                <button onClick={() => showSdk("usage", "sandbox")}>
                  <Command size={14} />
                  用量与控制
                </button>
                <button onClick={() => setSettings(true)}>
                  <Settings2 size={14} />
                  连接设置
                </button>
                <button
                  onClick={() =>
                    void action("logout", async () => {
                      await api("/auth/logout", {});
                      source.current?.close();
                      sessionSource.current?.close();
                      setShellOpen(false);
                      setAccountOpen(false);
                      setPassword("");
                      setLocked(true);
                    })
                  }
                >
                  <LogOut size={14} />
                  退出此设备
                </button>
              </div>
            </div>
          </aside>
          <div className="workspace" inert={drawerOpen}>
            <header className="topbar">
              <button
                className="icon mobile-only"
                aria-label="打开导航"
                aria-controls="workspace-navigation"
                aria-expanded={drawerOpen}
                ref={drawer.trigger}
                onClick={() => setSidebar(true)}
              >
                <Menu size={17} />
              </button>
              <span className="breadcrumb">
                {current?.repo}
                <span>/</span>
              </span>
              <span className="session-title">{current?.title}</span>
              <div className="header-right">
                <a
                  className="report-link"
                  href="/report"
                  target="_blank"
                  rel="noreferrer"
                  title="发布报告与服务"
                >
                  <FileText size={14} />
                  <span>Reports</span>
                </a>
                <button
                  className="usage-link"
                  title="当前会话用量与控制"
                  onClick={() => showSdk("usage")}
                >
                  用量与控制
                </button>
                <button
                  className="icon shell-toggle"
                  title="沙箱 Shell"
                  aria-label="沙箱 Shell"
                  onClick={() => setShellOpen(true)}
                >
                  <Code2 size={16} />
                </button>
                <div className="view-switch">
                  {(
                    [
                      { id: "zh", label: "中文" },
                      { id: "both", label: "双语" },
                      { id: "original", label: "原文" },
                    ] as const
                  ).map((v) => (
                    <button
                      key={v.id}
                      className={view === v.id ? "active" : ""}
                      onClick={() => setView(v.id)}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
              </div>
            </header>
            {connectionNotice}
            <div className="workspace-body">
              <main className="chat" data-empty={emptySession}>
                <Conversation
                  key={current?.id}
                  ref={conversation}
                  messages={messages}
                  blocks={blocks}
                  assets={assets}
                  view={view}
                  completedRunId={completedRunId}
                  activeRunId={runId}
                  liveText={deferredOutput}
                  liveRunId={running ? runId : ""}
                  onError={notify}
                  onOpen={openAsset}
                  onReference={referenceAsset}
                >
                  {capError && (
                    <div className="connection-error">
                      <span>{capError}</span>
                      <button
                        className="text-button"
                        onClick={() =>
                          current && void refreshCapabilities(current, true)
                        }
                      >
                        重试连接
                      </button>
                    </div>
                  )}
                  {emptySession && (
                    <div className="empty-session">
                      <h1>新会话</h1>
                      <span>输入任务或 / 命令</span>
                    </div>
                  )}
                  {running && (
                    <article className="message live">
                      <div className="message-head">
                        <strong>Claude Code</strong>
                        <ActivityLine
                          activities={activities}
                          connection={activityConnection}
                          fallback={activity || "等待模型响应"}
                          active={running}
                        />
                      </div>
                      {!messages.some(
                        (m) => m.role === "assistant" && m.runId === runId,
                      ) && (
                        <AssetRail
                          onError={notify}
                          assets={assets.filter((a) =>
                            a.publishedRuns?.includes(runId),
                          )}
                          onOpen={openAsset}
                        />
                      )}
                      {events
                        .filter(
                          (e) =>
                            (e.type === "permission" || e.type === "dialog") &&
                            !answered.includes((e.data as { id: string }).id),
                        )
                        .map((event) => (
                          <Interaction
                            key={event.seq}
                            event={event}
                            view={view}
                            pending={!!pending}
                            onAnswer={(reply) =>
                              void action("answer", async () => {
                                const id = (event.data as { id: string }).id;
                                await api(`/permissions/${id}`, reply);
                                setAnswered((list) => [...list, id]);
                              })
                            }
                          />
                        ))}
                    </article>
                  )}
                  {review && (
                    <section className="review-card">
                      <div className="review-title">
                        <ShieldCheck size={16} />
                        <strong ref={focusReview} tabIndex={-1}>
                          {review.status === "prepared"
                            ? "英文确认"
                            : "隐私处理"}
                        </strong>
                        <span>{review.steering ? "插话" : ""}</span>
                      </div>
                      <div
                        className={`review-text ${review.status === "prepared" ? "bilingual" : ""}`}
                      >
                        <div>
                          <span className="language-label">
                            原文 · 可划线选择文字
                          </span>
                          <div
                            className="source-prompt"
                            ref={original}
                            onMouseUp={captureSelection}
                            onKeyUp={captureSelection}
                            onTouchEnd={() => setTimeout(captureSelection, 0)}
                          >
                            <Marked
                              text={review.original}
                              findings={review.findings}
                              focused={focused}
                              onFocus={(id) => {
                                setFocused(id);
                                const finding = document.getElementById(
                                  "finding-" + id,
                                );
                                finding?.focus({ preventScroll: true });
                                finding?.scrollIntoView({
                                  block: "nearest",
                                  behavior: matchMedia(
                                    "(prefers-reduced-motion: reduce)",
                                  ).matches
                                    ? "auto"
                                    : "smooth",
                                });
                              }}
                            />
                          </div>
                          <button
                            className="text-button mark-button"
                            disabled={!selection || !!pending}
                            onClick={() => void markSelection()}
                          >
                            <Plus size={13} />
                            标记所选文字
                            {selection
                              ? `（${selection.end - selection.start} 字）`
                              : ""}
                          </button>
                        </div>
                        {review.english && (
                          <div>
                            <span className="language-label">
                              即将发送给 Claude Code
                            </span>
                            <pre className="english-preview">
                              {review.english}
                            </pre>
                          </div>
                        )}
                      </div>
                      <div className="review-bottom">
                        <button
                          className="text-button"
                          disabled={!!pending}
                          onClick={returnToDraft}
                        >
                          <ArrowLeft size={13} />
                          返回修改
                        </button>
                        <span>
                          {unresolved
                            ? `${unresolved} 处待处理`
                            : "已确认全部标记"}
                        </span>
                        <button
                          className="primary"
                          disabled={unresolved > 0 || !!pending}
                          onClick={() => void continueReview()}
                        >
                          {pending && <Busy />}
                          {review.status === "prepared"
                            ? "确认发送"
                            : review.mode !== "manual"
                              ? "确认并发送"
                              : "生成英文预览"}
                        </button>
                      </div>
                    </section>
                  )}
                </Conversation>
                <div className="composer-wrap">
                  <div className="run-status">
                    <ActivityLine
                      activities={activities}
                      connection={activityConnection}
                      fallback={
                        review && pending !== "review"
                          ? review.status === "prepared"
                            ? "等待发送确认"
                            : "等待隐私处理"
                          : capLoading && !running && !pending
                            ? "正在连接 Claude Code"
                            : activity || (running ? "等待模型响应" : "就绪")
                      }
                      active={!!pending || running || capLoading}
                    />
                    {tasks.length > 0 && (
                      <button
                        className="text-button"
                        onClick={() => showSdk("tasks")}
                      >
                        任务 {tasks.length}
                      </button>
                    )}
                    {running && (
                      <button
                        className="stop"
                        onClick={() =>
                          void action("interrupt", async () => {
                            await api(`/runs/${runId}/interrupt`, {});
                          })
                        }
                      >
                        <Square size={11} fill="currentColor" />
                        中断
                      </button>
                    )}
                  </div>
                  {candidates.length > 0 && (
                    <div
                      id="composer-candidates"
                      className="command-menu"
                      role="listbox"
                      aria-label="输入候选"
                    >
                      {candidates.map((candidate, index) => (
                        <button
                          key={candidate.id}
                          id={"candidate-" + index}
                          role="option"
                          aria-selected={index === candidateIndex}
                          tabIndex={-1}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={candidate.select}
                        >
                          <code>{candidate.label}</code>
                          <span>{candidate.description}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div
                    className={`composer ${dragging ? "dragging" : ""}`}
                    onDragOver={(e) => {
                      if (e.dataTransfer.types.includes("Files")) {
                        e.preventDefault();
                        setDragging(true);
                      }
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node))
                        setDragging(false);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragging(false);
                      void addFiles(Array.from(e.dataTransfer.files));
                    }}
                  >
                    <AssetRail
                      onError={notify}
                      assets={
                        review
                          ? []
                          : assets.filter((a) => attached.includes(a.id))
                      }
                      onOpen={(a) => setPreviewId(a.id)}
                      onReference={referenceAsset}
                      onRemove={(a) => {
                        attachmentRef.current = attachmentRef.current.filter(
                          (id) => id !== a.id,
                        );
                        setAttached(attachmentRef.current);
                      }}
                    />
                    <input
                      ref={fileInput}
                      type="file"
                      multiple
                      hidden
                      onChange={(e) => {
                        void addFiles(Array.from(e.target.files || []));
                        e.target.value = "";
                      }}
                    />
                    <textarea
                      ref={composer}
                      aria-label={running ? "输入插话" : "输入任务"}
                      rows={2}
                      value={review ? "" : prompt}
                      aria-controls={
                        candidates.length ? "composer-candidates" : undefined
                      }
                      aria-activedescendant={
                        candidates[candidateIndex]
                          ? "candidate-" + candidateIndex
                          : undefined
                      }
                      onChange={(e) => {
                        setPrompt(e.target.value);
                        setCandidateIndex(-1);
                        setCommandsOpen(e.target.value.startsWith("/"));
                        setReferencesOpen(/@[^@\s]*$/.test(e.target.value));
                      }}
                      placeholder={
                        running
                          ? "输入补充要求，发送插话…"
                          : "输入任务，/ 查看命令"
                      }
                      disabled={!!review}
                      onPaste={(e) => {
                        const files = Array.from(e.clipboardData.files);
                        if (files.length) {
                          e.preventDefault();
                          void addFiles(files);
                        }
                      }}
                      onBlur={() => {
                        setCommandsOpen(false);
                        setReferencesOpen(false);
                      }}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing) return;
                        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                          e.preventDefault();
                          if (!pending && !review) void send();
                        } else if (
                          candidates.length &&
                          (e.key === "ArrowDown" || e.key === "ArrowUp")
                        ) {
                          e.preventDefault();
                          const direction = e.key === "ArrowDown" ? 1 : -1;
                          setCandidateIndex((index) =>
                            index < 0
                              ? direction > 0
                                ? 0
                                : candidates.length - 1
                              : (index + direction + candidates.length) %
                                candidates.length,
                          );
                        } else if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          candidates[candidateIndex]
                        ) {
                          e.preventDefault();
                          candidates[candidateIndex].select();
                        } else if (e.key === "Escape") {
                          setCommandsOpen(false);
                          setReferencesOpen(false);
                        }
                      }}
                    />
                    <div className="composer-controls">
                      <div className="model-controls">
                        <button
                          className="icon"
                          aria-label="上传文件或图片"
                          title="上传文件或图片 · 也可拖入、粘贴"
                          disabled={uploading || !!review}
                          onClick={() => fileInput.current?.click()}
                        >
                          {uploading ? <Busy /> : <Paperclip size={14} />}
                        </button>
                        <Picker
                          label="主模型"
                          onOpen={() => {
                            if (current)
                              void refreshCapabilities(current, true);
                          }}
                          value={model}
                          options={modelOptions}
                          disabled={(capLoading && !caps) || !!pending}
                          onChange={(value) => {
                            setModel(value);
                            if (
                              effort !== "default" &&
                              effort !== "off" &&
                              !caps?.models
                                .find((m) => m.value === value)
                                ?.supportedEffortLevels?.includes(effort)
                            )
                              setEffort("default");
                            if (
                              permission === "auto" &&
                              !caps?.models.find((m) => m.value === value)
                                ?.supportsAutoMode
                            )
                              setPermission("default");
                            if (running && current)
                              void action("model", async () => {
                                await api(`/sessions/${current.id}/control`, {
                                  method: "setModel",
                                  args: [value],
                                });
                              });
                          }}
                        />
                        <Picker
                          label="工具调用审核"
                          value={permission}
                          options={(
                            caps?.permissionModes || [
                              "auto",
                              "default",
                              "acceptEdits",
                              "plan",
                              "dontAsk",
                            ]
                          ).map((value) => ({
                            value,
                            label: permissionNames[value as PermissionMode],
                            disabled:
                              value === "auto" &&
                              selectedModel?.supportsAutoMode === false,
                          }))}
                          disabled={!!pending}
                          onChange={(value) => {
                            setPermission(value as PermissionMode);
                            if (running && current)
                              void action("permission-mode", async () => {
                                await api(`/sessions/${current.id}/control`, {
                                  method: "setPermissionMode",
                                  args: [value],
                                });
                              });
                          }}
                        />
                        {narrow ? (
                          <button
                            type="button"
                            className="composer-more text-button"
                            ref={composerMore}
                            onClick={() => setComposerOptions(true)}
                            aria-haspopup="dialog"
                          >
                            <Settings2 size={14} /> 更多
                          </button>
                        ) : (
                          advancedComposerControls
                        )}
                      </div>
                      <button
                        className="send"
                        aria-label={running ? "发送插话" : "发送任务"}
                        disabled={
                          (!prompt.trim() && !attached.length) ||
                          !!pending ||
                          !!review ||
                          !current ||
                          uploading
                        }
                        onClick={() => void send()}
                      >
                        {pending === "send" ? (
                          <Busy />
                        ) : running ? (
                          <CornerDownLeft size={15} />
                        ) : (
                          <ArrowUp size={16} />
                        )}
                        <span>{running ? "插话" : "发送"}</span>
                      </button>
                    </div>
                  </div>
                </div>
              </main>
              {review && (
                <aside className="privacy-panel" aria-label="隐私审核面板">
                  <div className="privacy-head">
                    <strong>隐私标记</strong>
                    <span>
                      {review.findings.length - unresolved} /{" "}
                      {review.findings.length}
                    </span>
                  </div>
                  <div className="privacy-actions">
                    <button
                      className="text-button"
                      disabled={!!pending || !review.findings.length}
                      onClick={() =>
                        void action("all", async () =>
                          setReview(
                            await api<Review>(
                              `/reviews/${review.id}`,
                              {
                                decisions: review.findings.map((f) => ({
                                  id: f.id,
                                  strategy: "placeholder",
                                })),
                              },
                              "PATCH",
                            ),
                          ),
                        )
                      }
                    >
                      全部占位
                    </button>
                    <span>
                      {review.mode === "automatic"
                        ? "确认后自动发送"
                        : "手动两步确认"}
                    </span>
                  </div>
                  <div className="findings">
                    {review.findings.length === 0 && (
                      <p className="muted">
                        规则未发现敏感项。可在原文中划线选择并手动标记。
                      </p>
                    )}
                    {review.findings.map((finding) => (
                      <div
                        className={`finding ${focused === finding.id ? "focused" : ""}`}
                        id={"finding-" + finding.id}
                        tabIndex={-1}
                        key={finding.id}
                        onClick={() => setFocused(finding.id)}
                      >
                        <div className="finding-head">
                          <strong>{finding.label}</strong>
                          {finding.strategy !== "pending" && (
                            <Check size={13} />
                          )}
                        </div>
                        <code>{finding.value}</code>
                        <button
                          type="button"
                          className="text-button finding-locate"
                          onClick={() => {
                            setFocused(finding.id);
                            const mark = document.getElementById(
                              "source-mark-" + finding.id,
                            );
                            mark?.focus({ preventScroll: true });
                            mark?.scrollIntoView({ block: "nearest" });
                          }}
                        >
                          定位原文
                        </button>
                        <Picker
                          label={finding.label + "处理方式"}
                          value={finding.strategy}
                          onChange={(value) =>
                            void decide(finding.id, value as Strategy)
                          }
                          disabled={!!pending}
                          options={(
                            Object.entries(strategies) as [Strategy, string][]
                          ).map(([value, label]) => ({
                            value,
                            label,
                            disabled: value === "env" && finding.secret,
                          }))}
                        />
                        {finding.strategy === "placeholder" && (
                          <small>中文回复还原；生成文件保留代号。</small>
                        )}
                        {finding.strategy === "env" && (
                          <small className="warning">
                            进程可以读取 ENV。插话不能新增进程环境变量。
                          </small>
                        )}
                        {finding.strategy === "pass" && (
                          <small className="warning">
                            原值会交给 Claude Code，可能保存在明文卷中。
                          </small>
                        )}
                      </div>
                    ))}
                  </div>
                  <p className="privacy-note">
                    规则可能漏项。选中原文补充标记后再发送。
                  </p>
                </aside>
              )}
            </div>
            {current && (
              <PerformanceBar
                usage={current.usage}
                onOpen={() => showSdk("usage")}
              />
            )}
          </div>
          {narrow && (
            <Modal
              open={composerOptions}
              onOpenChange={setComposerOptions}
              title="输入设置"
              returnFocus={composerMore}
            >
              <div className="composer-options">{advancedComposerControls}</div>
            </Modal>
          )}
          <ControlsPanel
            open={sdkOpen}
            onOpenChange={setSdkOpen}
            session={current}
            capabilities={caps}
            initialTab={sdkTab}
            usageScope={usageScope}
            initialResult={controlResult}
            tasks={tasks}
            onChanged={(method, args) => {
              if (method === "setModel" && typeof args[0] === "string")
                setModel(args[0]);
              if (method === "setPermissionMode")
                setPermission(args[0] as PermissionMode);
              if (
                current &&
                !running &&
                [
                  "reloadSkills",
                  "reloadPlugins",
                  "setMcpServers",
                  "reloadOutputStyles",
                  "reinitialize",
                ].includes(method)
              )
                void refreshCapabilities(current, true);
            }}
          />
          {shellOpen && current && (
            <Suspense fallback={null}>
              <ShellPanel
                repo={current.repo}
                onClose={() => setShellOpen(false)}
              />
            </Suspense>
          )}
          <Modal open={settings} onOpenChange={setSettings} title="连接设置">
            {config && (
              <ConnectionForm
                config={config}
                onSaved={(value) => {
                  setConfig(value);
                  setSettings(false);
                  notify("连接配置已保存");
                  if (current) void refreshCapabilities(current, true);
                }}
              />
            )}
          </Modal>
          <Modal
            open={!!manageRepo}
            onOpenChange={(value) => {
              if (!value) setManageRepo("");
            }}
            title="沙箱管理"
            description={manageRepo}
            wide
          >
            {manageRepo && (
              <SandboxManager
                repo={manageRepo}
                notify={notify}
                onDestroyed={() => {
                  setManageRepo("");
                  void init();
                }}
              />
            )}
          </Modal>
          <Modal
            open={newSandbox}
            onOpenChange={setNewSandbox}
            title="新建沙箱"
          >
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                void action("new-sandbox", async () => {
                  const session = await api<Session>("/sessions", {
                    repo: repoDraft,
                  });
                  await refreshSessions();
                  await openSession(session);
                  setNewSandbox(false);
                });
              }}
            >
              <label className="field">
                沙箱标识
                <input
                  value={repoDraft}
                  onChange={(e) => setRepoDraft(e.target.value)}
                  pattern="[a-z0-9][a-z0-9_-]{0,47}"
                  maxLength={48}
                  required
                  placeholder="小写字母、数字、短横线"
                />
              </label>
              <button className="primary" disabled={!!pending}>
                创建
              </button>
            </form>
          </Modal>
          <Modal
            open={!!editSession}
            onOpenChange={(value) => {
              if (!value) setEditSession(undefined);
            }}
            title="会话"
          >
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                if (editSession)
                  void action("rename", async () => {
                    await api(`/sessions/${editSession.id}/rename`, { title });
                    await refreshSessions();
                    if (current?.id === editSession.id)
                      setCurrent({ ...current, title });
                    setEditSession(undefined);
                  });
              }}
            >
              <label className="field">
                名称
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  maxLength={100}
                />
              </label>
              <button className="primary" disabled={!!pending}>
                保存名称
              </button>
            </form>
            <div className="danger-zone">
              <p>删除工作台中的此会话记录，沙箱卷保留。</p>
              <button
                className="secondary danger-text"
                disabled={!!pending}
                onClick={() => {
                  if (editSession)
                    void action("delete", async () => {
                      await api(
                        `/sessions/${editSession.id}`,
                        undefined,
                        "DELETE",
                      );
                      removeDraft(editSession.id);
                      setEditSession(undefined);
                      await init();
                    });
                }}
              >
                <Trash2 size={13} />
                删除此会话
              </button>
            </div>
          </Modal>
          <AssetPreview
            asset={assets.find((a) => a.id === previewId)}
            all={assets}
            onClose={() => setPreviewId("")}
            onUpdate={(a) => {
              setAssets((list) => upsert(list, a));
              setPreviewId(a.id);
            }}
            onError={notify}
          />
          {toast && (
            <div className="toast" role="status">
              <span>{toast}</span>
              <button
                className="icon"
                aria-label="关闭提示"
                onClick={() => setToast("")}
              >
                <X size={14} />
              </button>
            </div>
          )}
        </div>
      </RichContext.Provider>
    </ArtifactLink.Provider>
  );
}
function Marked({
  text,
  findings,
  focused,
  onFocus,
}: {
  text: string;
  findings: Finding[];
  focused: string;
  onFocus: (id: string) => void;
}) {
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const finding of findings) {
    parts.push(text.slice(offset, finding.start));
    parts.push(
      <mark
        key={finding.id}
        id={"source-mark-" + finding.id}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onFocus(finding.id);
          }
        }}
        className={`${finding.strategy === "pending" ? "pending" : "resolved"} ${focused === finding.id ? "focused" : ""}`}
        onClick={() => onFocus(finding.id)}
      >
        {finding.value}
      </mark>,
    );
    offset = finding.end;
  }
  parts.push(text.slice(offset));
  return <>{parts}</>;
}
function Interaction({
  event,
  view = "zh",
  pending,
  onAnswer,
}: {
  event: RunEvent;
  view?: View;
  pending: boolean;
  onAnswer: (reply: Record<string, unknown>) => void;
}) {
  const data = event.data as {
    id: string;
    name?: string;
    input?: Record<string, unknown>;
    kind?: string;
    request?: Record<string, unknown>;
    translated?: Record<string, string>;
    translationError?: boolean;
  };
  const [value, setValue] = useState("{}"),
    [error, setError] = useState("");
  const questions = Array.isArray(data.input?.questions)
    ? (data.input!.questions as {
        question: string;
        header?: string;
        options?: { label: string; description?: string }[];
        multiSelect?: boolean;
      }[])
    : [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const translated = view === "original" ? undefined : data.translated;
  return (
    <div className="interaction">
      <strong>{questions.length ? "Claude 提问" : event.text}</strong>
      {data.translationError && (
        <small className="muted">问题翻译暂不可用，显示原文。</small>
      )}
      {questions.length ? (
        questions.map((question, index) => (
          <label className="field" key={question.question}>
            <span title={question.question}>
              {translated?.[`q${index}`] || question.question}
            </span>
            {view === "both" && translated?.[`q${index}`] && (
              <small className="muted">{question.question}</small>
            )}
            <div className="interaction-options">
              {question.options?.map((option, optionIndex) => (
                <button
                  type="button"
                  key={option.label}
                  title={option.label}
                  disabled={pending}
                  className={
                    (answers[question.question] || "")
                      .split(", ")
                      .includes(option.label)
                      ? "active"
                      : ""
                  }
                  onClick={() =>
                    setAnswers((current) => {
                      const previous = (current[question.question] || "")
                        .split(", ")
                        .filter(Boolean);
                      const selected = question.multiSelect
                        ? previous.includes(option.label)
                          ? previous.filter((v) => v !== option.label)
                          : [...previous, option.label]
                        : [option.label];
                      return {
                        ...current,
                        [question.question]: selected.join(", "),
                      };
                    })
                  }
                >
                  <span>
                    {translated?.[`o${index}_${optionIndex}`] || option.label}
                  </span>
                  {option.description && (
                    <small>
                      {translated?.[`d${index}_${optionIndex}`] ||
                        option.description}
                    </small>
                  )}
                </button>
              ))}
            </div>
            <input
              list={data.id + "-" + question.header}
              value={(answers[question.question] || "")
                .split(", ")
                .map((value) => {
                  const selected =
                    question.options?.findIndex(
                      (option) => option.label === value,
                    ) ?? -1;
                  return selected >= 0
                    ? translated?.[`o${index}_${selected}`] || value
                    : value;
                })
                .join(", ")}
              onChange={(e) =>
                setAnswers((a) => ({
                  ...a,
                  [question.question]: e.target.value,
                }))
              }
              placeholder="输入回答或选择建议"
            />
            <datalist id={data.id + "-" + question.header}>
              {question.options?.map((option, optionIndex) => (
                <option key={option.label} value={option.label}>
                  {translated?.[`o${index}_${optionIndex}`] || option.label} —{" "}
                  {translated?.[`d${index}_${optionIndex}`] ||
                    option.description}
                </option>
              ))}
            </datalist>
          </label>
        ))
      ) : (
        <details open>
          <summary>{data.name || "请求内容"}</summary>
          <JsonView value={data.input || data.request} />
        </details>
      )}
      {typeof translated?.message === "string" && <p>{translated.message}</p>}
      {event.type === "dialog" && (
        <label className="field">
          返回数据（JSON）
          <textarea
            className="code-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
      )}
      {(questions.length > 0 || event.type === "dialog") && (
        <p className="muted">
          中文回答会翻译后提交；敏感内容请通过输入框完成隐私审阅。
        </p>
      )}
      {error && <p className="error">{error}</p>}
      <div className="button-row">
        <button
          className="secondary"
          disabled={pending}
          onClick={() => onAnswer({ allow: false })}
        >
          拒绝
        </button>
        <button
          className="primary"
          disabled={pending}
          onClick={() => {
            try {
              const extra = JSON.parse(value);
              onAnswer({
                allow: true,
                ...(questions.length ? { updatedInput: { answers } } : {}),
                ...(event.type === "dialog"
                  ? { content: extra, result: extra }
                  : {}),
              });
            } catch {
              setError("请输入有效 JSON");
            }
          }}
        >
          {questions.length ? "提交回答" : "允许这一次"}
        </button>
      </div>
    </div>
  );
}

function upsert<T extends { id: string }>(list: T[], value: T): T[] {
  const previous = list.find((x) => x.id === value.id) as any;
  const next = { ...previous, ...value } as any;
  if (previous) {
    for (const key of ["chinese", "translatedCatalog", "descriptionZh"])
      if (previous[key] && !next[key]) next[key] = previous[key];
    if (previous.translationState === "done") next.translationState = "done";
  }
  return previous
    ? list.map((x) => (x.id === value.id ? next : x))
    : [...list, value];
}
