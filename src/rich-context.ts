import { createContext } from "react";
import type { Asset } from "../shared/types";
export const ArtifactLink = createContext<(id: string) => void>(() => {});
export const RichContext = createContext<{
  sessionId?: string;
  assets: Asset[];
  onAsset: (asset: Asset) => void;
  onError: (text: string) => void;
}>({ assets: [], onAsset: () => {}, onError: () => {} });
