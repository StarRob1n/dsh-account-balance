#!/usr/bin/env python3
"""Check dsh-balance-ball's community status and email a summary on change.

Run from GitHub Actions (see .github/workflows/notify.yml). Sends mail through
QQ Mail SMTP using an authorization code (never an account password).

Behaviour:
  - First run ever      -> send an "enabled" mail so the user can confirm setup
  - Any meaningful diff -> send a change mail (merge, comment, check colours)
  - Monday runs         -> send the weekly digest even when nothing changed
  - Otherwise           -> stay silent
"""

import json
import os
import smtplib
import ssl
import sys
import urllib.request
from datetime import datetime, timezone
from email.header import Header
from email.message import EmailMessage

STATE_PATH = os.environ.get("STATE_PATH", ".state/notify-state.json")

UPSTREAM_OWNER = "awesome-dsh-plugin"
UPSTREAM_REPO = "awesome-dsh-plugin"
PR_NUMBER = 12125

PLUGIN_REPO = "StarRob1n/dsh-account-balance"
PACKAGE = "dsh-balance-ball"
DSHBASE_URL = "https://dshbase.com/plugins/dsh-balance-ball/"
PR_URL = f"https://github.com/{UPSTREAM_OWNER}/{UPSTREAM_REPO}/pull/{PR_NUMBER}"

TOKEN = os.environ.get("GITHUB_TOKEN", "")


def log(msg):
    print(msg, flush=True)


def http_json(url, auth=False):
    headers = {"User-Agent": "dsh-balance-ball-notify", "Accept": "application/vnd.github+json"}
    if auth and TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def try_json(url, auth=False, default=None):
    try:
        return http_json(url, auth=auth)
    except Exception as exc:  # network hiccup must not break the whole run
        log(f"warn: {url} -> {exc}")
        return default


def page_ok(url):
    """True when the page answers with a 2xx status (HTML, so no JSON parsing)."""
    req = urllib.request.Request(url, headers={"User-Agent": "dsh-balance-ball-notify"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return 200 <= resp.status < 300
    except Exception as exc:
        log(f"warn: {url} -> {exc}")
        return False


def collect():
    state = {}

    pr = try_json(f"https://api.github.com/repos/{UPSTREAM_OWNER}/{UPSTREAM_REPO}/pulls/{PR_NUMBER}", auth=True)
    if pr:
        state["pr_state"] = pr.get("state")
        state["pr_merged"] = bool(pr.get("merged"))
        state["pr_updated"] = pr.get("updated_at")
        head = (pr.get("head") or {}).get("sha")
        state["head_sha"] = head
        if head:
            runs = try_json(
                f"https://api.github.com/repos/{UPSTREAM_OWNER}/{UPSTREAM_REPO}/commits/{head}/check-runs",
                auth=True,
            ) or {}
            for run in runs.get("check_runs") or []:
                name = run.get("name")
                if name == "Submission gate":
                    state["gate"] = run.get("conclusion") or run.get("status")
                    state["gate_title"] = (run.get("output") or {}).get("title")
                    state["gate_at"] = run.get("completed_at")
                elif name == "check":
                    state["check"] = run.get("conclusion") or run.get("status")

    comments = try_json(
        f"https://api.github.com/repos/{UPSTREAM_OWNER}/{UPSTREAM_REPO}/issues/{PR_NUMBER}/comments",
        auth=True,
        default=[],
    ) or []
    state["comment_ids"] = sorted(int(c["id"]) for c in comments if c.get("id"))
    state["comment_count"] = len(comments)
    state["last_comment_by"] = comments[-1]["user"]["login"] if comments else None

    repo = try_json(f"https://api.github.com/repos/{PLUGIN_REPO}", auth=True) or {}
    state["stars"] = repo.get("stargazers_count")
    state["forks"] = repo.get("forks_count")
    state["open_issues"] = repo.get("open_issues_count")

    dl = try_json(f"https://api.npmjs.org/downloads/point/last-week/{PACKAGE}") or {}
    state["downloads_week"] = dl.get("downloads")

    state["dshbase_ok"] = page_ok(DSHBASE_URL)

    return state


def load_state():
    try:
        with open(STATE_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None
    except Exception as exc:
        log(f"warn: unreadable state ({exc}); treating as first run")
        return None


def save_state(state):
    os.makedirs(os.path.dirname(STATE_PATH) or ".", exist_ok=True)
    with open(STATE_PATH, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=2)


def describe(state):
    gate = state.get("gate") or "缺失"
    check = state.get("check") or "缺失"
    return [
        f"PR #{PR_NUMBER}：{state.get('pr_state')}" + ("（已合并）" if state.get("pr_merged") else ""),
        f"评论数：{state.get('comment_count', 0)}",
        f"Submission gate：{gate}" + (f"（{state['gate_title']}）" if state.get("gate_title") else ""),
        f"check：{check}",
        f"star：{state.get('stars')} / fork：{state.get('forks')} / issue：{state.get('open_issues')}",
        f"npm 近 7 天下载：{state.get('downloads_week')}",
        f"dshbase 页面：{'在线' if state.get('dshbase_ok') else '异常'}",
    ]


def diff_events(old, new):
    """Return human-readable lines for every meaningful change."""
    events = []

    if new.get("pr_merged") and not old.get("pr_merged"):
        events.append("🎉 PR 已合并，插件正式进入 awesome-dsh-plugin 目录")
    if old.get("pr_state") != new.get("pr_state") and not new.get("pr_merged"):
        events.append(f"PR 状态变化：{old.get('pr_state')} → {new.get('pr_state')}")

    old_ids = set(old.get("comment_ids") or [])
    new_ids = set(new.get("comment_ids") or [])
    added = new_ids - old_ids
    if added:
        events.append(f"新增 {len(added)} 条 PR 评论（最后一条来自 {new.get('last_comment_by')}）")

    for field, label in (("gate", "Submission gate"), ("check", "check")):
        before, after = old.get(field), new.get(field)
        if before != after and after:
            line = f"{label}：{before} → {after}"
            if field == "gate" and new.get("gate_title"):
                line += f"（{new['gate_title']}）"
            events.append(line)

    if old.get("dshbase_ok") and not new.get("dshbase_ok"):
        events.append("⚠️ dshbase 插件页面变为不可访问")

    return events


def summary_text(state, events, weekly):
    lines = []
    if events:
        lines.append("【变化】")
        lines.extend(f"- {e}" for e in events)
        lines.append("")

    lines.append("【当前状态】")
    lines.extend(f"- {s}" for s in describe(state))
    lines.append("")

    if weekly:
        lines.append("【每周数据】")
        lines.append(f"- npm 近 7 天下载量：{state.get('downloads_week')}")
        lines.append(f"- star：{state.get('stars')}")
        lines.append(
            "- 提示：下载量里既有真人安装，也有镜像站与爬虫抓取。"
            "发布日尖峰、各版本下载量均匀是机器流量特征；"
            "连续几天稳定在数十次更可能是真实使用。"
        )
        lines.append("")

    lines.append(f"链接：{PR_URL}")
    lines.append(f"dshbase：{DSHBASE_URL}")
    return "\n".join(lines)


def send_mail(subject, body):
    user = os.environ.get("QQ_SMTP_USER")
    password = os.environ.get("QQ_SMTP_PASS")
    if not user or not password:
        log("QQ_SMTP_USER / QQ_SMTP_PASS 未配置，跳过发信")
        return False

    msg = EmailMessage()
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = user
    msg["To"] = os.environ.get("MAIL_TO") or user
    msg.set_content(body, charset="utf-8")

    context = ssl.create_default_context()
    with smtplib.SMTP_SSL("smtp.qq.com", 465, context=context, timeout=30) as server:
        server.login(user, password)
        server.send_message(msg)
    log(f"mail sent: {subject}")
    return True


def main():
    state = collect()
    if state.get("pr_state") is None and state.get("downloads_week") is None:
        log("all lookups failed; nothing to report")
        return

    old = load_state()
    save_state(state)

    now_utc = datetime.now(timezone.utc)
    weekly = now_utc.weekday() == 0

    if old is None:
        subject = f"[{PACKAGE}] 状态通知已启用"
        body = "状态邮件通知已成功配置。以后只在有变化时发信，每周一附一次数据摘要。\n\n" + summary_text(state, [], True)
        send_mail(subject, body)
        return

    events = diff_events(old, state)
    if events:
        head = events[0]
        subject = f"[{PACKAGE}] {head}"
        log(f"changes: {len(events)}")
        send_mail(subject, summary_text(state, events, weekly))
        return

    if weekly:
        send_mail(f"[{PACKAGE}] 每周数据摘要", summary_text(state, [], True))
        return

    log("no changes; staying quiet")


if __name__ == "__main__":
    main()
