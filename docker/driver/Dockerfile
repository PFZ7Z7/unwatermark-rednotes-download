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
old = '''entry = self._create_log_entry(f"Starting crawler: {' '.join(cmd)}", "info")'''
new = '''safe_cmd = [
                "***" if index > 0 and cmd[index - 1] == "--cookies" else value
                for index, value in enumerate(cmd)
            ]
            entry = self._create_log_entry(f"Starting crawler: {' '.join(safe_cmd)}", "info")'''
if old in manager_text:
    manager.write_text(manager_text.replace(old, new), encoding="utf-8")
PY

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/crawler/status', timeout=5).read()"

CMD ["python", "-m", "uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8080"]
