import { randomBytes } from "node:crypto";
import type { Finding } from "../shared/types.ts";

// Detection runs on this server before any translation/model request.
const rules: {
  kind: string;
  label: string;
  pattern: RegExp;
  secret?: boolean;
  group?: number;
}[] = [
  {
    kind: "PRIVATE_KEY",
    label: "私钥",
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    secret: true,
  },
  {
    kind: "API_KEY",
    label: "访问密钥",
    pattern:
      /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16}|ccsb_[A-Za-z0-9_-]{20,})\b/g,
    secret: true,
  },
  {
    kind: "SECRET",
    label: "密码 / 凭证",
    pattern:
      /(?:password|passwd|secret|api[_-]?key|access[_-]?token|密码|密钥)\s*[:=：]\s*["']?([^\s"'，。,；;]{4,})/gi,
    group: 1,
    secret: true,
  },
  {
    kind: "JWT",
    label: "登录令牌",
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    secret: true,
  },
  {
    kind: "EMAIL",
    label: "电子邮箱",
    pattern:
      /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}/g,
  },
  {
    kind: "ID",
    label: "身份证号",
    pattern:
      /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g,
  },
  {
    kind: "PHONE",
    label: "手机号码",
    pattern: /(?<!\d)(?:\+?86[ -]?)?1[3-9]\d[ -]?\d{4}[ -]?\d{4}(?!\d)/g,
  },
  {
    kind: "PHONE",
    label: "电话号码",
    pattern: /(?<!\w)\+\d{1,3}[ -](?:\d[ -]?){7,12}\d(?!\d)/g,
  },
  {
    kind: "PERSON",
    label: "姓名",
    pattern:
      /(?:我叫|姓名[：:]?\s*|联系人[：:]?\s*|负责人[：:]?\s*)([\p{Script=Han}]{2,4})(?=[，。\s,；;]|$)/gu,
    group: 1,
  },
  {
    kind: "ADDRESS",
    label: "详细地址",
    pattern:
      /(?:地址[：:]?\s*|住在)([\p{Script=Han}\dA-Za-z-]{5,70}(?:号|室|栋|楼)[\p{Script=Han}\d-]{0,12})/gu,
    group: 1,
  },
  {
    kind: "IP",
    label: "内部 IP 地址",
    pattern:
      /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g,
  },
  {
    kind: "URL_CREDENTIAL",
    label: "URL 内嵌凭证",
    pattern:
      /(?:https?|postgres(?:ql)?|mysql|redis):\/\/[^\s/:]+:[^\s/@]+@[^\s，。]+/g,
    secret: true,
  },
];
// A complete credential URL must take precedence over an email-shaped fragment.
rules.sort(
  (a, b) =>
    Number(b.kind === "URL_CREDENTIAL") - Number(a.kind === "URL_CREDENTIAL"),
);

export function detect(text: string): Finding[] {
  const found: Finding[] = [];
  for (const rule of rules) {
    for (const match of text.matchAll(new RegExp(rule.pattern))) {
      const value = match[rule.group ?? 0];
      const start =
        match.index! + (rule.group ? match[0].lastIndexOf(value) : 0);
      const end = start + value.length;
      if (
        found.some((f) => (start < f.end && end > f.start) || f.value === value)
      )
        continue;
      found.push(
        makeFinding(rule.kind, rule.label, value, start, end, !!rule.secret),
      );
    }
  }
  // A bank-card candidate must pass Luhn, reducing false positives in source code.
  for (const match of text.matchAll(/(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)/g)) {
    const digits = match[0].replace(/\D/g, "");
    const sum = [...digits].reverse().reduce((sum, char, i) => {
      let n = Number(char) * (i % 2 ? 2 : 1);
      return sum + (n > 9 ? n - 9 : n);
    }, 0);
    if (
      sum % 10 === 0 &&
      !found.some(
        (f) => match.index! < f.end && match.index! + match[0].length > f.start,
      )
    )
      found.push(
        makeFinding(
          "CARD",
          "银行卡号",
          match[0],
          match.index!,
          match.index! + match[0].length,
          true,
        ),
      );
  }
  return found.sort((a, b) => a.start - b.start);
}

export function makeFinding(
  kind: string,
  label: string,
  value: string,
  start: number,
  end: number,
  secret = false,
): Finding {
  const id = randomBytes(5).toString("hex").toUpperCase();
  return {
    id,
    kind,
    label,
    value,
    start,
    end,
    secret,
    severity: secret ? "high" : "medium",
    token: `__YJ_${kind}_${id}__`,
    envName: `YJ_${kind}_${id}`,
    strategy: "pending",
  };
}

export function protect(original: string, findings: Finding[]) {
  let text = original;
  // Replace every occurrence, not just the span first detected; regex-free literal replacement.
  for (const f of [...findings].sort((a, b) => b.value.length - a.value.length))
    text = text.split(f.value).join(f.token);
  return text;
}

export function materialize(text: string, findings: Finding[]) {
  for (const f of findings) {
    if (f.strategy === "pass") text = text.split(f.token).join(f.value);
    if (f.strategy === "env")
      text = text.split(f.token).join(`\${${f.envName}}`);
  }
  return text;
}

export function restore(
  text: string,
  findings: Pick<Finding, "token" | "value" | "envName">[],
) {
  for (const f of findings)
    text = text
      .split(f.token)
      .join(f.value)
      .split(`\${${f.envName}}`)
      .join(f.value);
  return text;
}

export function maskOutput(
  text: string,
  findings: Pick<Finding, "token" | "value" | "envName">[],
) {
  for (const f of [...findings].sort(
    (a, b) => b.value.length - a.value.length,
  )) {
    text = text
      .split(f.value)
      .join(f.token)
      .split(`\${${f.envName}}`)
      .join(f.token);
  }
  return text;
}
