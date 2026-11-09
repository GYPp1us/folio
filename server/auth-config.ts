import { config } from "./config.ts";
export const usesWebLogin = (repo: string) =>
  config.webLoginRepos.includes(repo);
export function claudeEnv(
  repo: string,
  forceWeb = false,
): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CONFIG_DIR: "/home/ccuser/.claude",
    PATH: "/usr/local/bin:/usr/bin:/bin",
  };
  if (!forceWeb && !usesWebLogin(repo) && config.oauth)
    env.CLAUDE_CODE_OAUTH_TOKEN = config.oauth;
  return env;
}
