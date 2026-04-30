# 小红书解析方案调研报告

## 一、开源项目（GitHub）

### 1. MediaCrawler ⭐ 推荐
**仓库**: `NanmiCoder/MediaCrawler`
**功能**:
- 支持小红书、抖音、快手、B站等多平台
- 支持视频、图片下载
- 已实现签名算法逆向
- 支持登录态保持

**技术栈**: Python + Playwright
**优点**: 维护活跃，功能完整
**缺点**: 需要Python环境

### 2. xhs (小红书爬虫)
**仓库**: `ReaJason/xhs`
**功能**:
- 小红书笔记爬取
- 用户信息获取
- 评论数据

**技术栈**: Python
**优点**: 轻量级，专注小红书

### 3. XiaoHongShuCrawler
**仓库**: 搜索 `XiaoHongShuCrawler`
**功能**:
- 笔记信息爬取
- 图片下载

### 4. xiaohongshu-web-scraper
**仓库**: 搜索 `xiaohongshu-scraper`
**功能**:
- Web端数据爬取
- 无需登录

---

## 二、第三方API服务

### 免费API

| 服务 | 地址 | 说明 | 限制 |
|------|------|------|------|
| 公共解析接口 | 多个GitHub项目提供 | 基于开源项目部署 | 可能不稳定 |

### 付费API

| 服务 | 说明 | 价格参考 |
|------|------|----------|
| 易解析 | 多平台解析服务 | 按次/包月 |
| API市场 | RapidAPI等平台 | 各不相同 |
| 自建服务 | 基于开源项目部署 | 服务器成本 |

---

## 三、技术实现方案对比

| 方案 | 难度 | 稳定性 | 成本 | 推荐度 |
|------|------|--------|------|--------|
| 第三方API | ⭐ | ⭐⭐⭐⭐ | 💰 | ⭐⭐⭐⭐ |
| MediaCrawler | ⭐⭐⭐ | ⭐⭐⭐ | 免费 | ⭐⭐⭐⭐⭐ |
| 自建服务 | ⭐⭐⭐⭐ | ⭐⭐⭐ | 服务器费用 | ⭐⭐⭐ |
| Playwright模拟 | ⭐⭐ | ⭐⭐ | 免费 | ⭐⭐ |

---

## 四、推荐方案

### 方案A: 使用 MediaCrawler（最推荐）

**优点**:
- 完整的签名算法实现
- 持续维护更新
- 支持多种功能
- 免费开源

**部署方式**:
1. 克隆项目
2. 安装依赖
3. 配置Cookie
4. 启动服务

### 方案B: 对接免费API

一些开发者会分享免费的解析接口，可以在以下地方找到：
- GitHub Issues
- 技术论坛
- 开发者社区

### 方案C: 自建解析服务

基于 MediaCrawler 或其他开源项目，自己部署一个API服务。

---

## 五、快速开始

### 使用 MediaCrawler

```bash
# 克隆项目
git clone https://github.com/NanmiCoder/MediaCrawler.git
cd MediaCrawler

# 安装依赖
pip install -r requirements.txt

# 配置
# 修改 config/base_config.py

# 运行
python main.py --platform xhs --type note
```

### 核心代码参考

MediaCrawler 的小红书解析核心代码位于：
- `media_platform/xhs/` 目录
- `media_platform/xhs/field.py` - 字段定义
- `media_platform/xhs/help.py` - 辅助函数

---

## 六、建议

**对于你的项目**，我建议：

1. **短期方案**: 使用 MediaCrawler 作为后端解析服务
2. **长期方案**: 学习 MediaCrawler 的签名算法，集成到你的 Node.js 后端

这样可以：
- 快速实现功能
- 保证稳定性
- 降低维护成本
