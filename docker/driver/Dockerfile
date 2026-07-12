# syntax=docker/dockerfile:1.6

ARG PYTHON_IMAGE=python:3.11-slim-bookworm
FROM ${PYTHON_IMAGE} AS driver

WORKDIR /app

ARG USE_ALIYUN_APT_MIRROR=false
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG PLAYWRIGHT_DOWNLOAD_HOST=
ARG MEDIACRAWLER_REPO=https://github.com/NanmiCoder/MediaCrawler.git
ARG MEDIACRAWLER_REF=165776886faf56d44651d4dbd290b015582a97f2

ENV PYTHONUNBUFFERED=1
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PIP_NO_CACHE_DIR=1

RUN if [ "${USE_ALIYUN_APT_MIRROR}" = "true" ]; then \
        sed -i \
          -e 's|http://deb.debian.org/debian|http://mirrors.cloud.aliyuncs.com/debian|g' \
          -e 's|http://deb.debian.org/debian-security|http://mirrors.cloud.aliyuncs.com/debian-security|g' \
          /etc/apt/sources.list.d/debian.sources; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN git init MediaCrawler \
    && cd MediaCrawler \
    && git remote add origin "${MEDIACRAWLER_REPO}" \
    && git fetch --depth 1 origin "${MEDIACRAWLER_REF}" \
    && git checkout --detach FETCH_HEAD

WORKDIR /app/MediaCrawler

COPY docker/driver/xhs_cookie_validate.py api/xhs_cookie_validate.py

RUN python -m pip install --upgrade pip \
    && python -m pip config set global.index-url "${PIP_INDEX_URL}" \
    && python -m pip install -r requirements.txt

RUN if [ "${USE_ALIYUN_APT_MIRROR}" = "true" ]; then \
        sed -i \
          -e 's|http://deb.debian.org/debian|http://mirrors.cloud.aliyuncs.com/debian|g' \
          -e 's|http://deb.debian.org/debian-security|http://mirrors.cloud.aliyuncs.com/debian-security|g' \
          /etc/apt/sources.list.d/debian.sources; \
    fi \
    && python -m playwright install-deps chromium \
    && if [ -n "${PLAYWRIGHT_DOWNLOAD_HOST}" ]; then \
         PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST}" python -m playwright install chromium; \
       else \
         python -m playwright install chromium; \
       fi \
    && rm -rf /var/lib/apt/lists/*

RUN sed -i \
      -e 's/^HEADLESS = .*/HEADLESS = True/' \
      -e 's/^SAVE_LOGIN_STATE = .*/SAVE_LOGIN_STATE = False/' \
      -e 's/^ENABLE_CDP_MODE = .*/ENABLE_CDP_MODE = False/' \
      -e 's/^CDP_HEADLESS = .*/CDP_HEADLESS = True/' \
      -e 's/^SAVE_DATA_OPTION = .*/SAVE_DATA_OPTION = "jsonl"/' \
      config/base_config.py \
    && mkdir -p browser_data data

RUN python - <<'PY'
from pathlib import Path

main = Path("api/main.py")
main_text = main.read_text(encoding="utf-8")
install_line = "from api.xhs_cookie_validate import install_xhs_cookie_validation\ninstall_xhs_cookie_validation(app)\n"
if "install_xhs_cookie_validation(app)" not in main_text:
    main.write_text(main_text + "\n" + install_line, encoding="utf-8")

manager = Path("api/services/crawler_manager.py")
manager_text = manager.read_text(encoding="utf-8")
manager_text = manager_text.replace(
    'cmd = ["uv", "run", "python", "main.py"]',
    'cmd = ["python", "main.py"]',
)
old = '''entry = self._create_log_entry(f"Starting crawler: {' '.join(cmd)}", "info")'''
new = '''safe_cmd = [
                "***" if index > 0 and cmd[index - 1] == "--cookies" else value
                for index, value in enumerate(cmd)
            ]
            entry = self._create_log_entry(f"Starting crawler: {' '.join(safe_cmd)}", "info")'''
if old in manager_text:
    manager_text = manager_text.replace(old, new)
manager_text = manager_text.replace(
    '''                # If still not exited, force kill
                if self.process.poll() is None:
                    entry = self._create_log_entry("Process not responding, sending SIGKILL...", "warning")
                    await self._push_log(entry)
                    self.process.kill()

                entry = self._create_log_entry("Crawler process terminated", "info")''',
    '''                # If still not exited, force kill
                if self.process.poll() is None:
                    entry = self._create_log_entry("Process not responding, sending SIGKILL...", "warning")
                    await self._push_log(entry)
                    self.process.kill()

                # Reap the child process so it cannot remain as a zombie.
                if self.process:
                    loop = asyncio.get_event_loop()
                    await loop.run_in_executor(None, self.process.wait)

                entry = self._create_log_entry("Crawler process terminated", "info")''',
)
manager_text = manager_text.replace(
    '''            # Process ended
            if self.status == "running":
                exit_code = self.process.returncode if self.process else -1
                if exit_code == 0:''',
    '''            # Process ended. wait() reaps the child process after stdout is drained.
            exit_code = -1
            if self.process:
                exit_code = await loop.run_in_executor(None, self.process.wait)
            if self.status == "running":
                if exit_code == 0:''',
)
manager.write_text(manager_text, encoding="utf-8")

browser_launcher = Path("tools/browser_launcher.py")
browser_launcher_text = browser_launcher.read_text(encoding="utf-8")
old = '''        if process.poll() is not None:
            utils.logger.info("[BrowserLauncher] Browser process already exited, no cleanup needed")
            self.browser_process = None
            return'''
new = '''        if process.poll() is not None:
            utils.logger.info("[BrowserLauncher] Browser process already exited, reaping it")
            try:
                process.wait(timeout=0)
            except Exception:
                pass
            self.browser_process = None
            return'''
if old in browser_launcher_text:
    browser_launcher_text = browser_launcher_text.replace(old, new)
browser_launcher.write_text(browser_launcher_text, encoding="utf-8")

xhs_core = Path("media_platform/xhs/core.py")
xhs_core_text = xhs_core.read_text(encoding="utf-8")
xhs_core_text = xhs_core_text.replace(
    "BrowserContext,\n    BrowserType,",
    "Browser,\n    BrowserContext,\n    BrowserType,",
)
xhs_core_text = xhs_core_text.replace(
    "    browser_context: BrowserContext\n    cdp_manager: Optional[CDPBrowserManager]",
    "    browser: Optional[Browser]\n    browser_context: BrowserContext\n    cdp_manager: Optional[CDPBrowserManager]",
)
xhs_core_text = xhs_core_text.replace(
    "        self.cdp_manager = None\n        self.ip_proxy_pool = None",
    "        self.browser = None\n        self.cdp_manager = None\n        self.ip_proxy_pool = None",
)
xhs_core_text = xhs_core_text.replace(
    "            browser = await chromium.launch(headless=headless, proxy=playwright_proxy)  # type: ignore\n"
    "            browser_context = await browser.new_context(viewport={\"width\": 1920, \"height\": 1080}, user_agent=user_agent)\n"
    "            return browser_context",
    "            self.browser = await chromium.launch(headless=headless, proxy=playwright_proxy)  # type: ignore\n"
    "            browser_context = await self.browser.new_context(viewport={\"width\": 1920, \"height\": 1080}, user_agent=user_agent)\n"
    "            return browser_context",
)
xhs_core_text = xhs_core_text.replace(
    "        else:\n"
    "            await self.browser_context.close()\n"
    "        utils.logger.info(\"[XiaoHongShuCrawler.close] Browser context closed ...\")",
    "        else:\n"
    "            await self.browser_context.close()\n"
    "            if self.browser:\n"
    "                try:\n"
    "                    await self.browser.close()\n"
    "                except Exception as browser_error:\n"
    "                    utils.logger.warning(f\"[XiaoHongShuCrawler.close] Browser close failed: {browser_error}\")\n"
    "                finally:\n"
    "                    self.browser = None\n"
    "        utils.logger.info(\"[XiaoHongShuCrawler.close] Browser context closed ...\")",
)
xhs_core.write_text(xhs_core_text, encoding="utf-8")

main_text = main.read_text(encoding="utf-8")
main_text = main_text.replace(
    '["uv", "run", "main.py", "--help"]',
    '["python", "main.py", "--help"]',
)
main_text = main_text.replace(
    '"uv", "run", "main.py", "--help",',
    '"python", "main.py", "--help",',
)
main.write_text(main_text, encoding="utf-8")
PY

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/crawler/status', timeout=5).read()"

CMD ["python", "-m", "uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8080"]
