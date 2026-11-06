#!/usr/bin/env python3
"""Weekly digest for dsh-balance-ball.

Runs from GitHub Actions (see .github/workflows/notify.yml) once a week and mails
a short summary of how the plugin is doing: npm downloads, GitHub stars, open
issues, and whether the community directory listings are still live.

Mail goes out through QQ Mail SMTP using an authorization code (never an account
password) to the address configured in QQ_SMTP_USER.

Behaviour:
  - first run ever  -> send an "enabled" mail so setup can be confirmed
  - FORCE_SEND=1    -> send regardless of the weekday (used by manual dispatch)
  - Monday runs     -> send the weekly digest
  - otherwise       -> stay silent
"""

import json
import os
import smtplib
import ssl
import urllib.request
from datetime import datetime, timezone
from email.message import EmailMessage

STATE_PATH = os.environ.get("STATE_PATH", ".state/notify-state.json")

PLUGIN_REPO = "StarRob1n/dsh-account-balance"
PACKAGE = "dsh-balance-ball"

UPSTREAM = "awesome-dsh-plugin/awesome-dsh-plugin"
LISTING_PATH = "data/plugins/StarRob1n__dsh-account-balance.yml"
LISTING_URL = f"https://github.com/{UPSTREAM}/blob/main/{LISTING_PATH}"

DSHBASE_URL = "https://dshbase.com/plugins/dsh-balance-ball/"
REPO_URL = f"https://github.com/{PLUGIN_REPO}"
NPM_URL = f"https://www.npmjs.com/package/{PACKAGE}"

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
    except Exception as exc:  # a network hiccup must not break the whole run
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


def npm_downloads(period):
    data = try_json(f"https://api.npmjs.org/downloads/point/{period}/{PACKAGE}") or {}
    return data.get("downloads")


def collect():
    state = {"checked_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")}

    repo = try_json(f"https://api.github.com/repos/{PLUGIN_REPO}", auth=True) or {}
    state["stars"] = repo.get("stargazers_count")
    state["forks"] = repo.get("forks_count")
    state["open_issues"] = repo.get("open_issues_count")
    state["pushed_at"] = repo.get("pushed_at")

    state["downloads_week"] = npm_downloads("last-week")
    state["downloads_day"] = npm_downloads("last-day")

    listing = try_json(
        f"https://api.github.com/repos/{UPSTREAM}/contents/{LISTING_PATH}", auth=True
    ) or {}
    state["listed"] = bool(listing.get("sha"))

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


def with_delta(label, new, old, unit=""):
    """Render 'npm 近 7 天下载：811（上次 795，+16）' style lines."""
    shown = "未知" if new is None else f"{new}{unit}"
    if new is None or old is None:
        return f"{label}：{shown}"
    diff = new - old
    if diff == 0:
        change = "持平"
    else:
        change = f"{'+' if diff > 0 else ''}{diff}{unit}"
    return f"{label}：{shown}（上次 {old}{unit}，{change}）"


def summary_text(state, old):
    old = old or {}
    lines = ["【本周数据】"]

    week = state.get("downloads_week")
    day = state.get("downloads_day")
    lines.append("- " + with_delta("npm 近 7 天下载", week, old.get("downloads_week")))
    lines.append(f"- npm 昨日下载：{'未知' if day is None else day}")
    lines.append("- " + with_delta("GitHub star", state.get("stars"), old.get("stars")))
    lines.append("- " + with_delta("未关闭 issue/PR", state.get("open_issues"), old.get("open_issues")))
    lines.append(f"- awesome-dsh-plugin 目录：{'已收录' if state.get('listed') else '未找到'}")
    lines.append(f"- dshbase 目录页：{'在线' if state.get('dshbase_ok') else '异常'}")

    if old.get("listed") and not state.get("listed"):
        lines.append("")
        lines.append("提醒：插件条目在上游 awesome 目录里查不到了，建议确认是否被误删。")
    if old.get("dshbase_ok") and not state.get("dshbase_ok"):
        lines.append("")
        lines.append("提醒：dshbase 插件页面打不开，也可能只是临时抖动。")

    lines.append("")
    lines.append("【说明】")
    lines.append(
        "下载量里既有真人安装，也有镜像站与爬虫抓取。"
        "发布日尖峰、各版本下载量均匀是机器流量特征；"
        "连续几周稳定在数十次更可能是真实使用。"
    )
    lines.append("")
    lines.append("【链接】")
    lines.append(f"- 仓库：{REPO_URL}")
    lines.append(f"- npm：{NPM_URL}")
    lines.append(f"- awesome 目录条目：{LISTING_URL}")
    lines.append(f"- dshbase：{DSHBASE_URL}")
    return "\n".join(lines)


def send_mail(subject, body):
    user = os.environ.get("QQ_SMTP_USER")
    password = os.environ.get("QQ_SMTP_PASS")
    if not user or not password:
        log("QQ_SMTP_USER / QQ_SMTP_PASS missing, skipping mail")
        return False

    msg = EmailMessage()
    # EmailMessage's default policy encodes non-ASCII headers itself; assigning a
    # Header object here raises "TypeError: 'Header' object is not subscriptable".
    msg["Subject"] = subject
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
    if state.get("stars") is None and state.get("downloads_week") is None:
        log("all lookups failed; nothing to report")
        return

    old = load_state()
    save_state(state)

    forced = (os.environ.get("FORCE_SEND") or "").lower() in ("1", "true", "yes")
    first_run = old is None
    weekly = datetime.now(timezone.utc).weekday() == 0

    if not (forced or first_run or weekly):
        log("not Monday and not forced; staying quiet")
        return

    if first_run:
        subject = f"[{PACKAGE}] 周报已启用"
        body = "每周一的数据摘要已配置完成，之后每周一封。\n\n" + summary_text(state, old)
    elif forced:
        subject = f"[{PACKAGE}] 周报测试"
        body = "这是一封手动触发的测试邮件，用于确认链路正常。\n\n" + summary_text(state, old)
    else:
        subject = f"[{PACKAGE}] 每周数据摘要"
        body = summary_text(state, old)

    send_mail(subject, body)


if __name__ == "__main__":
    main()
