"""Render the repository layout as an editable draw.io diagram plus local previews.

Scope: directory and module ownership of the current local source tree.
It does not start the product, does not call any Agent, and is not an
acceptance claim. Run from the repository root:

    python docs/architecture/build_project_structure.py

Outputs (next to this file):
    project-structure.drawio   editable draw.io source (one page)
    project-structure.svg      scalable preview
    project-structure.png      raster preview (Pillow)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from hashlib import sha256
from pathlib import Path
import html
import json
import math
import sys
import xml.etree.ElementTree as ET
from zoneinfo import ZoneInfo

from PIL import Image, ImageDraw, ImageFont

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
STAMP = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d %H:%M")
FONT_PATH = Path("C:/Windows/Fonts/msyh.ttc")
BOLD_PATH = Path("C:/Windows/Fonts/msyhbd.ttc")

TONE = {
    "default": ("#FFFFFF", "#94A3B8"),
    "core": ("#EFF6FF", "#5B80AD"),
    "sandbox": ("#EFF6FF", "#5B80AD"),
    "host": ("#FFF7E8", "#B88A3D"),
    "external": ("#EDF8F4", "#568B78"),
    "storage": ("#F3F4F6", "#8B96A5"),
    "tooling": ("#F5F3FF", "#7C6CB0"),
}


@dataclass
class Box:
    id: str
    title: str
    x: int
    y: int
    w: int
    h: int
    tone: str = "default"
    lines: list[str] = field(default_factory=list)


@dataclass
class Flow:
    source: str
    target: str
    label: str = ""
    dashed: bool = False
    start: str | None = None
    end: str | None = None
    via: list[tuple[int, int]] = field(default_factory=list)
    label_seg: int | None = None
    label_at: float = 0.5


def count(glob: str) -> int:
    return len([p for p in ROOT.glob(glob) if p.is_file()])


def lines_of(relative: str) -> int:
    path = ROOT / relative
    if not path.exists():
        return 0
    return len(path.read_text(encoding="utf-8", errors="ignore").splitlines())


def font(size=13, bold=False):
    return ImageFont.truetype(str(BOLD_PATH if bold else FONT_PATH), size)


def wrap(label: str, width: float, size: int) -> list[str]:
    face = font(size)
    out: list[str] = []
    for paragraph in label.split("\n"):
        current = ""
        for char in paragraph:
            if current and face.getlength(current + char) > width:
                out.append(current)
                current = char
            else:
                current += char
        out.append(current)
    return out


def fit_lines(box: Box) -> tuple[int, list[str]]:
    """Pick the largest body font that fits the box, and wrap every line."""
    for size in (11, 10, 9):
        width = box.w - 28
        body: list[str] = []
        for item in box.lines:
            body.extend(wrap(item, width, size))
        if 46 + len(body) * (size + 5) <= box.h:
            return size, body
    return 9, [part for item in box.lines for part in wrap(item, box.w - 28, 9)]


def build_boxes() -> list[Box]:
    server_modules = count("apps/server/src/*.ts") + count("apps/server/src/ports/*.ts")
    protocol_modules = count("packages/protocol/src/*.ts")
    script_files = count("scripts/*")
    test_files = count("tests/*.test.ts")
    doc_files = count("docs/*.md")
    web_files = count("apps/web/src/*")
    sandbox_cs = count("sandbox/RoomSandbox/*.cs")

    boxes: list[Box] = []

    def add(box_id, title, x, y, w, h, tone, items):
        boxes.append(Box(box_id, title, x, y, w, h, tone, items))

    add("web", "apps/web — 浏览器工作台", 35, 140, 388, 195, "core", [
        f"React 19 + Vite · {web_files} 个源文件",
        "main.tsx — 时间线 / 任务 / 交付物 / 讨论 / 用量",
        "markdown.tsx — Markdown 与 KaTeX 公式渲染",
        "run-drafts.ts — 本地草稿与未完成分组",
        "style.css · workbench.css · settings.css",
        "index.html · vite.config.ts",
    ])

    add("client", "packages/client — TS SDK", 468, 140, 388, 195, "core", [
        "index.ts — RoomClient（人类身份）",
        "index.ts — RoomAgentClient（房间 + 成员令牌）",
        "event-cursor.ts — seq 去重、缺口重连、游标恢复",
        "面向浏览器 / Owner 客户端与外部 Agent",
        "examples/room-client.ts — 最小接入示例",
    ])

    add("protocol", "packages/protocol — 协议 0.1", 901, 140, 388, 195, "core", [
        f"{protocol_modules} 个模块 · 应用契约唯一真源",
        "index.ts — 命令 / 事件 Zod Schema 与校验",
        "events · discussion · run-state · settings",
        "task-contract · usage · resource-lease",
        "project-binding · collaboration · reconciliation",
        "schema/*.schema.json — JSON Schema 生成物",
    ])

    add("external", "外部会话接入（MCP）", 1334, 140, 388, 195, "external", [
        "scripts/room-agent-mcp.mjs — MCP stdio → HTTP",
        "POST /api/agent/tool · 令牌绑定房间与成员",
        "plugins/tempt-room-claude — Claude Code 插件",
        "scripts/room-agent-runner.mjs — 可选值守 runner",
        "room-bridge.mjs · room-pipes.cjs — 沙箱工具桥",
    ])

    add("http", "main.ts · app.ts", 35, 400, 244, 290, "core", [
        f"apps/server/src · {server_modules} 个 .ts 模块",
        "main.ts — 入口 127.0.0.1:4317",
        "server.lock 单实例",
        "owner-session.token 持久化",
        "app.ts — Fastify HTTP + WS /api/events",
        "认证：Cookie / Bearer / room-token",
        "Room-Protocol-Version: 0.1",
    ])

    add("service", "service.ts — 命令服务", 324, 400, 244, 290, "core", [
        f"RoomService · {lines_of('apps/server/src/service.ts')} 行",
        "命令校验与幂等回执",
        "房间成员与点名唤醒",
        "有界讨论与 quorum",
        "任务创建 / 认领 / 转交 / 修订",
        "任务版本与外部租约",
        "decision 与成果应用闸门",
    ])

    add("worker", "worker.ts · scheduler.ts", 613, 400, 244, 290, "core", [
        f"Worker.tick · 250 ms · {lines_of('apps/server/src/worker.ts')} 行",
        "全局并发与会话串行",
        "任务依赖、租约回收",
        "取消、重试与失败归因",
        "scheduler.ts — 公平排序",
        "queue.ts — 输出流队列",
        "resource-manager.ts — 资源租约",
    ])

    add("adapters", "adapters · acp · codex", 902, 400, 244, 290, "core", [
        "Codex app-server 适配",
        "Claude stream-json 适配",
        "DeepSeek ACP 适配",
        "codex-attach.ts 线程绑定",
        "Chat Completions 与 A2A 1.0",
        "network.ts — 出站检查",
        "输出归一化：文本 / 用量 / 交付物",
    ])

    add("context", "context.ts · sessions.ts", 1191, 400, 244, 290, "core", [
        "上下文快照：最近 40 条",
        "每条最多 6000 字符",
        "baseSeq 对账与上下文预算",
        "原生会话作用域",
        "房间 / 成员 / 任务版本 / 模型",
        "external-context.ts 外部租约上下文",
    ])

    add("store", "store.ts · 事件投影", 1480, 400, 244, 290, "storage", [
        "SQLite WAL · schema v16",
        "events 表只追加 + 不可变触发器",
        "as_of_seq 投影与 reducer",
        "commands 回执表（幂等键）",
        "projection_offsets 游标",
        "ports/ — EventStore 端口",
    ])

    add("sandbox", "sandbox/RoomSandbox（C# .NET 10）", 35, 755, 302, 195, "sandbox", [
        f"{sandbox_cs} 个 .cs 文件",
        "AppContainer 身份 + 目录 ACL",
        "Job Object 进程树与生命周期",
        "Program.cs · SandboxProcess.cs",
        "RoomPipe.cs — LOCAL 命名管道校验",
        "Native.cs — 原生调用",
    ])

    add("pipecompat", "sandbox/RoomPipeCompat", 382, 755, 302, 195, "sandbox", [
        "compat.cpp — Node 管道兼容模块",
        "MSVC x64 编译",
        "需 VS 2022「使用 C++ 的桌面开发」",
        "在 AppContainer 内提供受限管道能力",
    ])

    add("host", "本机直连与工作区", 729, 755, 302, 195, "host", [
        "host.ts — HostChannel（当前用户权限）",
        "host-workspace.ts · workspaces.ts",
        "真实项目目录直接修改",
        "project-manifest.ts — 基线清单哈希",
        "不经过快照与成果应用",
    ])

    add("remote", "远程边界（公网）", 1076, 755, 302, 195, "external", [
        "A2A 1.0 — Card / 轮询 / Artifact",
        "Chat Completions — SSE 或 room-json",
        "outbound.ts · outbound-summary.ts",
        "远程文件 URL 仅引用不下载",
    ])

    add("state", ".state/ — 本地状态目录", 1423, 755, 302, 195, "storage", [
        "room.sqlite（WAL）· owner-session.token",
        "sandboxes/ · homes/ — 隔离目录",
        "runtimes/ · artifacts/ — 运行与交付物",
        "backup-state.mjs / restore-state.mjs",
        "正文留在磁盘，库中只存索引与事件",
    ])

    add("scripts", "scripts/ — 验证与运维", 35, 1015, 388, 195, "tooling", [
        f"{script_files} 个脚本",
        "preflight.ts · production-smoke.ts",
        "release-readiness.ts · acceptance-*.ts",
        "browser-e2e.ts（需本机浏览器）",
        "smoke-codex / claude / deepseek / host-*",
        "build-*.mjs · install-minimax-mcp.mjs",
    ])

    add("tests", "tests/ — node:test", 468, 1015, 388, 195, "tooling", [
        f"{test_files} 个测试文件 · 不调用模型",
        "协议 / 幂等 / 并发冲突 / 事件重放",
        "执行 fencing / 恢复证明",
        "预算、用量与账本",
        "工具授权与策略",
        "沙箱与宿主隔离 / 外部 MCP / A2A",
    ])

    add("docs", "docs/ — 文档与证据", 901, 1015, 388, 195, "tooling", [
        f"{doc_files} 篇文档",
        "ARCHITECTURE · PROTOCOL · Scheme",
        "AGENT-SETUP · CODEX / CLAUDE / DEEPSEEK",
        "ACCEPTANCE · RELEASE-READINESS",
        "architecture/ — 架构图与本结构图",
    ])

    add("misc", "其余目录", 1334, 1015, 388, 195, "tooling", [
        "examples/ — a2a-agent.ts · room-client.ts",
        "tools/job-launcher — Job Object 启动器",
        "plugins/tempt-room-claude — 插件与命令",
        ".github/workflows/ci.yml — CI 门禁",
        "dist/ 构建产物 · node_modules/ 依赖",
    ])

    return boxes


def build_flows() -> list[Flow]:
    return [
        Flow("web", "client", "HTTP", start="right", end="left"),
        Flow("client", "protocol", "类型", start="right", end="left"),
        Flow("http", "service", "命令", start="right", end="left"),
        Flow("service", "worker", "Run", start="right", end="left"),
        Flow("worker", "adapters", "适配器", start="right", end="left"),
        Flow("external", "http", "POST /api/agent/tool", start="bottom", end="top",
             via=[(1528, 388), (157, 388)], label_seg=1, label_at=0.08),
        Flow("service", "protocol", "Zod 校验", dashed=True, start="top", end="bottom",
             via=[(446, 348), (1095, 348)], label_seg=1, label_at=0.45),
        Flow("service", "store", "事务写入", start="bottom", end="bottom",
             via=[(446, 706), (1602, 706)], label_seg=1, label_at=0.92),
        Flow("store", "worker", "Run 队列 / 状态", dashed=True, start="bottom", end="bottom",
             via=[(1602, 712), (735, 712)], label_seg=1, label_at=0.5),
        Flow("adapters", "sandbox", "stdio JSON 帧", start="bottom", end="top",
             via=[(1024, 692), (1000, 692), (1000, 744), (186, 744)], label_seg=3, label_at=0.62),
        Flow("sandbox", "pipecompat", "管道", start="right", end="left"),
        Flow("adapters", "host", "本机直连模式", dashed=True, start="left", end="top",
             via=[(880, 545)], label_seg=1, label_at=0.5),
        Flow("adapters", "remote", "公网 HTTPS / A2A", start="bottom", end="top",
             via=[(1024, 698), (1227, 698)], label_seg=2, label_at=0.45),
        Flow("store", "state", "", start="bottom", end="top",
             via=[(1602, 696), (1574, 696)]),
        Flow("scripts", "http", "预检 / 验收", dashed=True, start="top", end="bottom",
             via=[(229, 968), (25, 968), (25, 712), (157, 712)], label_seg=1, label_at=0.5),
        Flow("tests", "service", "协议与集成用例", dashed=True, start="top", end="bottom",
             via=[(662, 968), (706, 968), (706, 692), (446, 692)], label_seg=3, label_at=0.5),
    ]


PAGE_WIDTH = 1760
PAGE_HEIGHT = 1265
BANDS = [
    (20, 100, 1720, 250, "① 交互与接入：工作台 · SDK · 协议 · 外部 MCP"),
    (20, 360, 1720, 345, "② 服务端内核 apps/server/src（Fastify + SQLite + 调度器）"),
    (20, 715, 1720, 250, "③ 执行隔离与外部边界：沙箱 · 本机直连 · 远程 · 状态"),
    (20, 975, 1720, 250, "④ 工程化：脚本 · 测试 · 文档 · 示例与 CI"),
]


def port(box: Box, side: str) -> tuple[int, int]:
    if side == "left":
        return (box.x, box.y + box.h // 2)
    if side == "right":
        return (box.x + box.w, box.y + box.h // 2)
    if side == "top":
        return (box.x + box.w // 2, box.y)
    return (box.x + box.w // 2, box.y + box.h)


def route(boxes: list[Box], flow: Flow) -> list[tuple[int, int]]:
    """Explicit orthogonal path: source port -> waypoints -> target port."""
    index = {b.id: b for b in boxes}
    a, b = index[flow.source], index[flow.target]
    dx, dy = b.x - a.x, b.y - a.y
    default = ("right", "left") if abs(dx) > abs(dy) else ("bottom", "top")
    if abs(dx) > abs(dy) and dx < 0:
        default = ("left", "right")
    if abs(dx) <= abs(dy) and dy < 0:
        default = ("top", "bottom")
    start_side = flow.start or default[0]
    end_side = flow.end or default[1]
    return [port(a, start_side)] + list(flow.via) + [port(b, end_side)]


def render(boxes: list[Box], flows: list[Flow]) -> None:
    scale = 2
    image = Image.new("RGB", (PAGE_WIDTH * scale, PAGE_HEIGHT * scale), "white")
    draw = ImageDraw.Draw(image)
    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{PAGE_WIDTH}" height="{PAGE_HEIGHT}" viewBox="0 0 {PAGE_WIDTH} {PAGE_HEIGHT}">',
        '<rect width="100%" height="100%" fill="#fff"/>',
    ]

    def shape(x, y, w, h, fill, stroke, radius=10, width=2):
        draw.rounded_rectangle(
            (x * scale, y * scale, (x + w) * scale, (y + h) * scale),
            radius=radius * scale, fill=fill, outline=stroke, width=width,
        )
        svg.append(
            f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}" stroke-width="1.2"/>'
        )

    def text(x, y, content, size=13, bold=False, color="#172B45", center=False):
        draw.text((x * scale, y * scale), content, font=font(size * scale, bold), fill=color, anchor="mt" if center else "lt")
        anchor = "middle" if center else "start"
        svg.append(
            f'<text x="{x}" y="{y + size}" text-anchor="{anchor}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" '
            f'font-size="{size}" font-weight="{600 if bold else 400}" fill="{color}">{html.escape(content)}</text>'
        )

    text(40, 24, "Tempt Room · 项目结构图", 27, True)
    text(40, 76, "目录与模块归属 · 依据本地源码生成 · 不启动产品、不调用模型 · " + STAMP + " CST", 13, color="#64748B")

    for x, y, w, h, title in BANDS:
        shape(x, y, w, h, "#F8FAFC", "#DCE3EC", 9)

    paths = []
    for flow in flows:
        points = route(boxes, flow)
        paths.append((flow, points))
        color = "#60738A"
        dash = ' stroke-dasharray="5 4"' if flow.dashed else ""
        svg.append(
            f'<polyline points="{" ".join(f"{x},{y}" for x, y in points)}" fill="none" stroke="{color}" stroke-width="1.4"{dash}/>'
        )
        for p, q in zip(points, points[1:]):
            if not flow.dashed:
                draw.line((p[0] * scale, p[1] * scale, q[0] * scale, q[1] * scale), fill=color, width=3)
            else:
                length = max(abs(q[0] - p[0]), abs(q[1] - p[1]))
                segments = max(1, length // 10)
                for i in range(segments):
                    t0, t1 = i / segments, (i + 0.55) / segments
                    draw.line(
                        (
                            (p[0] + (q[0] - p[0]) * t0) * scale,
                            (p[1] + (q[1] - p[1]) * t0) * scale,
                            (p[0] + (q[0] - p[0]) * t1) * scale,
                            (p[1] + (q[1] - p[1]) * t1) * scale,
                        ),
                        fill=color,
                        width=3,
                    )
        p, q = points[-2], points[-1]
        angle = math.atan2(q[1] - p[1], q[0] - p[0])
        length = 9
        triangle = [
            q,
            (q[0] - length * math.cos(angle - 0.45), q[1] - length * math.sin(angle - 0.45)),
            (q[0] - length * math.cos(angle + 0.45), q[1] - length * math.sin(angle + 0.45)),
        ]
        draw.polygon([(x * scale, y * scale) for x, y in triangle], fill=color)
        svg.append('<polygon points="' + " ".join(f"{x:.1f},{y:.1f}" for x, y in triangle) + f'" fill="{color}"/>')

    for box in boxes:
        fill, stroke = TONE[box.tone]
        shape(box.x, box.y, box.w, box.h, fill, stroke, 8)
        text(box.x + 14, box.y + 10, box.title, 13, True, "#172B45")
        draw.line(
            (
                (box.x + 12) * scale,
                (box.y + 34) * scale,
                (box.x + box.w - 12) * scale,
                (box.y + 34) * scale,
            ),
            fill=stroke,
            width=1,
        )
        svg.append(
            f'<line x1="{box.x + 12}" y1="{box.y + 34}" x2="{box.x + box.w - 12}" y2="{box.y + 34}" stroke="{stroke}" stroke-width="1"/>'
        )
        size, body = fit_lines(box)
        for i, item in enumerate(body):
            text(box.x + 14, box.y + 40 + i * (size + 5), item, size, False, "#41546B")

    for flow, points in paths:
        if not flow.label:
            continue
        segments = list(zip(points, points[1:]))
        if flow.label_seg is not None and flow.label_seg < len(segments):
            p, q = segments[flow.label_seg]
        else:
            p, q = max(segments, key=lambda pair: abs(pair[0][0] - pair[1][0]) + abs(pair[0][1] - pair[1][1]))
        x = p[0] + (q[0] - p[0]) * flow.label_at
        y = p[1] + (q[1] - p[1]) * flow.label_at
        width = font(11).getlength(flow.label) + 14
        shape(x - width / 2, y - 10, width, 20, "#FFFFFF", "#FFFFFF", 3, 0)
        text(x, y - 9, flow.label, 11, False, "#465B73", center=True)

    for x, y, w, h, title in BANDS:
        width = font(14).getlength(title) + 20
        shape(x + 12, y + 6, width, 26, "#FFFFFF", "#FFFFFF", 6, 0)
        text(x + 22, y + 11, title, 14, True, "#52637B")

    text(40, 1234, "实线：调用或依赖方向　虚线：跨层依赖或非运行时关系　方框内为该目录承担的核心文件。", 12, False, "#64748B")
    svg.append("</svg>")
    (OUT / "project-structure.svg").write_text("\n".join(svg), encoding="utf-8")
    image.save(OUT / "project-structure.png", optimize=True)


def write_drawio(boxes: list[Box], flows: list[Flow]) -> None:
    file = ET.Element("mxfile", {"host": "app.diagrams.net", "type": "device", "version": "24.7.17"})
    diagram = ET.SubElement(file, "diagram", {"id": "project-structure", "name": "项目结构"})
    model = ET.SubElement(
        diagram,
        "mxGraphModel",
        {
            "dx": str(PAGE_WIDTH),
            "dy": str(PAGE_HEIGHT),
            "grid": "1",
            "gridSize": "10",
            "page": "1",
            "pageWidth": str(PAGE_WIDTH),
            "pageHeight": str(PAGE_HEIGHT),
            "background": "#FFFFFF",
            "adaptiveColors": "auto",
        },
    )
    root = ET.SubElement(model, "root")
    ET.SubElement(root, "mxCell", {"id": "0"})
    ET.SubElement(root, "mxCell", {"id": "1", "parent": "0"})

    def cell(cell_id, value, x, y, w, h, style):
        node = ET.SubElement(root, "mxCell", {"id": cell_id, "value": value, "style": style, "vertex": "1", "parent": "1"})
        ET.SubElement(node, "mxGeometry", {"x": str(x), "y": str(y), "width": str(w), "height": str(h), "as": "geometry"})

    text_style = "text;html=0;align=left;verticalAlign=middle;whiteSpace=wrap;overflow=hidden;fontFamily=Microsoft YaHei;fontColor=#172B45;"
    cell("title", "Tempt Room · 项目结构图", 40, 22, PAGE_WIDTH - 80, 40, text_style + "fontSize=27;fontStyle=1;")
    cell(
        "subtitle",
        "目录与模块归属 · 依据本地源码生成 · 不启动产品、不调用模型 · " + STAMP + " CST",
        40,
        72,
        PAGE_WIDTH - 80,
        24,
        text_style + "fontSize=13;fontColor=#64748B;",
    )
    for i, (x, y, w, h, title) in enumerate(BANDS):
        cell(
            f"band{i}",
            title,
            x,
            y,
            w,
            h,
            "rounded=1;arcSize=8;html=0;whiteSpace=wrap;verticalAlign=top;align=left;spacingTop=10;spacingLeft=14;"
            "fontFamily=Microsoft YaHei;fontSize=14;fontStyle=1;fontColor=#52637B;fillColor=#F8FAFC;strokeColor=#DCE3EC;container=0;",
        )
    for box in boxes:
        fill, stroke = TONE[box.tone]
        cell(
            f"{box.id}-title",
            box.title,
            box.x,
            box.y,
            box.w,
            34,
            "rounded=1;arcSize=12;html=0;whiteSpace=wrap;verticalAlign=middle;align=left;spacingLeft=14;"
            f"fontFamily=Microsoft YaHei;fontSize=13;fontStyle=1;fontColor=#172B45;fillColor={fill};strokeColor={stroke};",
        )
        cell(
            f"{box.id}-body",
            "&#10;".join(box.lines),
            box.x,
            box.y + 34,
            box.w,
            box.h - 34,
            "rounded=1;arcSize=12;html=0;whiteSpace=wrap;verticalAlign=top;align=left;spacingLeft=14;spacingTop=8;"
            f"fontFamily=Microsoft YaHei;fontSize=11;fontColor=#41546B;fillColor={fill};strokeColor={stroke};",
        )
    for i, flow in enumerate(flows):
        style = (
            "edgeStyle=orthogonalEdgeStyle;rounded=0;html=0;endArrow=block;endFill=1;strokeColor=#60738A;strokeWidth=1.4;"
            "fontFamily=Microsoft YaHei;fontSize=11;fontColor=#465B73;labelBackgroundColor=#FFFFFF;"
        )
        if flow.dashed:
            style += "dashed=1;dashPattern=5 4;"
        ports = {"left": (0, 0.5), "right": (1, 0.5), "top": (0.5, 0), "bottom": (0.5, 1)}
        for side, prefix in [(flow.start, "exit"), (flow.end, "entry")]:
            if side:
                px, py = ports[side]
                style += f"{prefix}X={px};{prefix}Y={py};{prefix}Dx=0;{prefix}Dy=0;"
        node = ET.SubElement(
            root,
            "mxCell",
            {
                "id": f"flow{i}",
                "value": flow.label,
                "style": style,
                "edge": "1",
                "source": f"{flow.source}-title",
                "target": f"{flow.target}-title",
                "parent": "1",
            },
        )
        ET.SubElement(node, "mxGeometry", {"relative": "1", "as": "geometry"})
    (OUT / "project-structure.drawio").write_bytes(ET.tostring(file, encoding="utf-8", xml_declaration=True))


def main() -> None:
    OUT.mkdir(exist_ok=True)
    boxes = build_boxes()
    flows = build_flows()
    write_drawio(boxes, flows)
    render(boxes, flows)
    sources = [
        "apps/web/src/main.tsx",
        "apps/server/src/main.ts",
        "apps/server/src/app.ts",
        "apps/server/src/service.ts",
        "apps/server/src/worker.ts",
        "apps/server/src/store.ts",
        "apps/server/src/context.ts",
        "apps/server/src/adapters.ts",
        "packages/protocol/src/index.ts",
        "packages/client/src/index.ts",
        "scripts/room-agent-mcp.mjs",
        "sandbox/RoomSandbox/Program.cs",
    ]
    evidence = {
        "generatedAtShanghai": STAMP,
        "scope": "local source layout only; not a deployment or acceptance claim",
        "sources": [{"path": p, "sha256": sha256((ROOT / p).read_bytes()).hexdigest()} for p in sources],
        "boxes": len(boxes),
        "flows": len(flows),
    }
    (OUT / "project-structure-source.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "drawio": str(OUT / "project-structure.drawio"),
                "svg": str(OUT / "project-structure.svg"),
                "png": str(OUT / "project-structure.png"),
                "boxes": len(boxes),
                "flows": len(flows),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
