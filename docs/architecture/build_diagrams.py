"""Render the checked-in source architecture as editable draw.io and local previews.

Requires Pillow only for PNG previews. It does not start the product or any Agent.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from hashlib import sha256
from heapq import heappop, heappush
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
COLORS = {
    "default": ("#FFFFFF", "#94A3B8"),
    "core": ("#EFF6FF", "#5B80AD"),
    "sandbox": ("#EFF6FF", "#5B80AD"),
    "host": ("#FFF7E8", "#B88A3D"),
    "external": ("#EDF8F4", "#568B78"),
    "storage": ("#F3F4F6", "#8B96A5"),
    "warning": ("#FFF7E8", "#B88A3D"),
}


@dataclass
class Node:
    id: str
    label: str
    x: int
    y: int
    w: int = 140
    h: int = 60
    tone: str = "default"
    shape: str = "box"


@dataclass
class Edge:
    source: str
    target: str
    label: str = ""
    dashed: bool = False
    start: str | None = None
    end: str | None = None
    both: bool = False


@dataclass
class Page:
    id: str
    title: str
    subtitle: str
    width: int
    height: int
    nodes: list[Node] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)
    groups: list[tuple] = field(default_factory=list)
    notes: list[tuple] = field(default_factory=list)

    def node(self, id, label, col, row, **kw):
        self.nodes.append(Node(id, label, col * 180 + 40, row * 120 + 40, **kw))

    def edge(self, source, target, label="", **kw):
        self.edges.append(Edge(source, target, label, **kw))


overview = Page("overview", "Tempt Room · 当前项目架构", "以本地源码为准 · Node.js 模块化单体 + 独立 Windows 沙箱宿主", 1480, 1160)
overview.groups = [
    (20, 120, 340, 380, "交互与外部接入"),
    (380, 120, 700, 620, "Node.js 24 / Fastify · 同一个应用进程"),
    (1100, 120, 340, 620, "本地状态与文件"),
    (20, 560, 340, 180, "公共契约与发布包"),
    (380, 780, 1060, 300, "进程与远程系统边界"),
]
overview.node("human", "用户\n一个人类 / 多个房间", 0, 1)
overview.node("web", "React 19 + Vite\n时间线 / 任务 / 设置", 1, 1)
overview.node("client", "RoomClient\nHTTP 命令与查询\nWS 游标恢复", 1, 2, tone="core")
overview.node("external", "外部 Agent 会话\nCodex / Claude / DSH\n自行管理进程与登录", 0, 3, tone="external")
overview.node("mcp", "room-agent-mcp\nMCP stdio → HTTP\n可选 runner 值守", 1, 3, tone="external")
overview.node("http", "Fastify HTTP\n认证 / 来源 / 版本\napp.ts", 2, 1, tone="core")
overview.node("ws", "WebSocket /events\n持久事件 + 临时 delta\napp.ts", 2, 2, tone="core")
overview.node("tools", "房间工具入口\n/api/agent/tool\nAgent + 房间绑定", 2, 3, tone="external")
overview.node("service", "RoomService\n命令 / 讨论 / 任务\n版本与幂等", 3, 1, tone="core")
overview.node("context", "上下文 / 原生会话\ncontext.ts / sessions.ts\nseq 快照与恢复绑定", 3, 2, tone="core")
overview.node("worker", "Worker\n250 ms 调度 / 并发\n取消 / 工具 / 成果", 3, 3, tone="core")
overview.node("store", "Store\n事务 / 事件日志\n提交后发布通知", 5, 1, tone="storage")
overview.node("workspace", "Workspaces\n快照 / 差异 / 应用\n基线与路径检查", 5, 3, tone="core")
overview.node("native", "本地 Agent 适配器\nCodex / Claude / DSH\nadapters.ts", 3, 5, tone="core")
overview.node("remote", "API / A2A 适配器\nHTTPS / SSE / 轮询\nadapters + network", 5, 5, tone="core")
overview.node("sqlite", "SQLite WAL\nroom.sqlite", 6, 1, tone="storage", shape="db")
overview.node("owner", "启动会话凭据\nowner-session.token\n重启复用 / 显式轮换", 7, 1, tone="storage")
overview.node("files", "工作与运行目录\nsandboxes / homes\nruntimes", 6, 3, tone="storage")
overview.node("artifacts", "成果 / 基线 / 日志\nartifacts / manifests\napply", 7, 3, tone="storage")
overview.node("protocol", "Room Protocol 0.1\n类型 / Zod / Schema\npackages/protocol", 0, 5, tone="core")
overview.node("sdk", "TypeScript 客户端\nRoomClient\nRoomAgentClient", 1, 5, tone="core")
overview.node("sandbox", "RoomSandbox .NET 10\nAppContainer + ACL\nJob Object", 3, 7, tone="sandbox")
overview.node("host", "本机直连 HostChannel\n当前用户权限\nHostRoomPipe", 4, 7, tone="host")
overview.node("nativecli", "原生 Agent CLI\nstdin / stdout\n进程树与原生会话", 3, 8)
overview.node("internet", "公网服务\n模型 API / 远程 A2A\n独立远程端点", 6, 7)
for args, kw in [
    (("human", "web"), {}), (("web", "client"), {}),
    (("client", "http", "HTTP"), {"start": "right", "end": "left"}),
    (("http", "service", "命令"), {}), (("service", "store", "事务写入"), {}),
    (("store", "sqlite"), {}), (("service", "context", "固化"), {}),
    (("context", "worker"), {"dashed": True}),
    (("store", "worker", "Run 队列 / 状态"), {"start": "bottom", "end": "right", "both": True}),
    (("store", "ws", "已提交事件"), {"start": "bottom", "end": "top"}),
    (("worker", "ws", "流片段"), {"dashed": True, "start": "left", "end": "bottom"}),
    (("ws", "client"), {}),
    (("external", "mcp"), {}), (("mcp", "tools", "房间令牌"), {}),
    (("tools", "worker"), {}),
    (("worker", "workspace", "快照 / 差异"), {}),
    (("workspace", "files"), {}), (("workspace", "artifacts"), {"start": "bottom", "end": "bottom"}),
    (("worker", "native", "本地执行"), {}),
    (("worker", "remote", "远程执行"), {"start": "bottom", "end": "left"}),
    (("native", "sandbox", "stdio JSON IPC"), {}),
    (("native", "host", "显式 host 模式"), {"start": "right", "end": "top"}),
    (("sandbox", "nativecli"), {}), (("host", "nativecli"), {"start": "bottom", "end": "right"}),
    (("nativecli", "internet", "CLI 自行访问模型"), {"start": "right", "end": "bottom"}),
    (("remote", "internet", "公网 HTTPS"), {}),
    (("protocol", "sdk"), {"dashed": True}),
]:
    overview.edge(*args, **kw)
overview.notes = [
    (40, 800, "边界说明", 16, True),
    (40, 835, "实线：调用、执行或状态流\n虚线：上下文依赖或临时流片段\n服务模块同进程；没有消息中间件。\nSQLite 的 runs 表就是持久队列。", 13, False),
    (40, 945, "执行模式必须区分", 16, True),
    (40, 980, "沙箱：隔离工作区，审阅后应用。\nhost：可直接修改真实项目。\nexternal：房间服务不管理其进程。", 13, False),
    (1120, 540, "数据库保存索引、实体与事件；\n大文件正文保存在状态目录。\n密钥通过环境变量引用注入。", 13, False),
    (400, 1105, "Room Protocol 是应用契约；MCP 是工具接入；ACP / App Server / A2A 分别适配 Agent 原生接口。", 13, False),
]

execution = Page("execution", "执行路径与成果落地", "四条代码路径分别展示 · 不把本机直连和外部会话画成沙箱", 1540, 1140)
lanes = [(180, "托管 · AppContainer 沙箱"), (540, "托管 · 本机直连 host"), (900, "外部会话 / MCP"), (1260, "托管 · API / A2A")]
execution.groups = [(x, 120, 220, 920, title) for x, title in lanes]
columns = [1, 3, 5, 7]
labels = [
    ["Worker 管理 Run\n同房间同 Agent 串行", "任务：独立快照\n聊天：成员独立目录\n隔离 home / 只读工具", "C# 沙箱宿主\n验证 AppContainer / Job", "Codex / Claude / DSH\n原生流式协议", "room-bridge / MCP\nLOCAL 管道回到 Worker", "任务：Patch / 报告\n记录基线与任务版本", "用户审阅并应用\n冲突检查 / 应用日志"],
    ["Worker 管理 Run\n显式选择 host 模式", "任务：真实项目目录\n聊天：房间共享目录", "HostChannel 启动 CLI\n使用当前用户权限", "Codex / Claude / DSH\n原生流式协议", "HostRoomPipe + MCP\n工具仍绑定房间与运行", "任务：Git 变更报告\n聊天：共享仓库提交", "真实文件已经修改\n不经过 Patch 应用步骤"],
    ["用户自己的 Agent 进程\n或当前 Codex 会话", "MCP stdio / TS SDK\n可选 runner 自动值守", "HTTP /api/agent/tool\nAgent + 房间专用令牌", "Worker.agentTool\n幂等 / 成员 / 版本检查", "外部 Agent 自行执行\n认领任务与心跳续租", "task_complete / 报告\n租约失效则回收任务", "公开消息与交付物\n服务不创建托管 Run"],
    ["Worker 管理 Run\n统一状态与超时", "network.ts\nHTTPS / DNS 公网过滤", "API：Chat Completions\nA2A：Agent Card 1.0", "API：SSE / JSON 回复\nA2A：任务轮询 / 取消", "归一化 AgentOutput\ntext / usage / artifact", "Worker 保存并发布\nStore + WebSocket", "讨论 / 结构化交付物\nAPI 无本地执行 Harness"],
]
for index, (col, items) in enumerate(zip(columns, labels)):
    tone = ["sandbox", "host", "external", "core"][index]
    for row, label in enumerate(items, 1):
        execution.node(f"mode{index}_{row}", label, col, row, tone=tone)
        execution.nodes[-1].x -= 10
        execution.nodes[-1].w = 160
        if row > 1:
            execution.edge(f"mode{index}_{row-1}", f"mode{index}_{row}")
execution.notes = [
    (40, 145, "入口", 14, True), (40, 265, "目录 / 传输", 14, True),
    (40, 385, "边界", 14, True), (40, 505, "运行", 14, True),
    (40, 625, "交互 / 输出", 14, True), (40, 745, "成果", 14, True),
    (40, 865, "落地", 14, True),
    (190, 990, "取消：Job Object 终止进程树", 11, False),
    (550, 990, "同一真实项目任务串行执行", 11, False),
    (910, 990, "普通 Agent 发言不自动唤醒同伴", 11, False),
    (1270, 990, "远程接口必须与 Card 同源", 11, False),
    (40, 1080, "沙箱代码路径存在并执行原生隔离检查；本图描述实现结构，不代表每个真实 Agent 的完整沙箱验收已经完成。", 13, False),
]

flow = Page("events", "命令、调度与可靠事件流", "普通消息 / 点名 / 讨论 / 任务均由应用协议调度；Agent 之间没有直连群聊总线", 1480, 1110)
flow.groups = [(20, 120, 1420, 620, "一次托管请求：写入、执行与反馈"), (20, 780, 1420, 240, "目标变化与成果保护")]
flow.node("user", "React / TS 客户端\ncommandId / v0.1", 0, 1)
flow.node("auth", "HTTP 接入检查\n会话 / 来源 / 协议", 1, 1, tone="core")
flow.node("cmd", "RoomService.execute\n身份与命令校验\n同 ID 返回同 Receipt", 2, 1, tone="core")
flow.node("tx", "Store.atomic\nBEGIN IMMEDIATE\n状态 + 事件 + 回执", 3, 1, tone="storage")
flow.node("queue", "queued Run\n任务版本 / limits\n共享上下文 contextId", 4, 1, tone="storage")
flow.node("poll", "Worker.tick · 250 ms\n并发 / 会话串行\n依赖与租约检查", 5, 1, tone="core")
flow.node("adapter", "runAdapter\n原生 / API / A2A\n统一输出与中断", 6, 1, tone="core")
flow.node("delta", "message.delta\nmessageId + index\n临时流片段", 6, 3, tone="core")
flow.node("final", "持久化最终结果\n消息 / 状态 / 成果\n事件 seq 递增", 5, 3, tone="storage")
flow.node("commit", "事务成功后通知\nStore.listeners\n不广播回滚事件", 3, 3, tone="storage")
flow.node("ws", "WebSocket /api/events\nafter 游标补发 + 订阅\n流片段不承担可靠历史", 2, 3, tone="core")
flow.node("reconnect", "客户端事件订阅\nseq 去重 / 缺口重连\n按上次游标恢复", 1, 3, tone="core")
flow.node("ui", "React 时间线\n独立流式消息\n完成后清理临时片段", 0, 3)
flow.node("v1", "任务 v1\n可有依赖下游任务", 0, 7)
flow.node("revise", "revise / handoff\n递增任务版本\n取消受影响旧运行", 2, 7, tone="warning")
flow.node("stale", "标记旧结果 stale\n传播依赖版本变化\n新要求冻结新快照", 4, 7, tone="warning")
flow.node("apply", "应用成果前核对\n任务/依赖版本 + 基线\n冲突则停止写入", 6, 7, tone="core")
for a, b, label in [("user","auth",""),("auth","cmd",""),("cmd","tx",""),("tx","queue","原子"),("queue","poll","轮询"),("poll","adapter",""),("adapter","delta","流式"),("adapter","final","结束"),("final","commit","提交后"),("commit","ws","事件"),("ws","reconnect",""),("reconnect","ui",""),("v1","revise","修改目标"),("revise","stale",""),("stale","apply","沙箱成果")]:
    flow.edge(a,b,label)
flow.edge("delta","ws","临时推送",dashed=True,start="bottom",end="bottom")
flow.notes = [
    (40, 550, "唤醒规则", 16, True),
    (40, 585, "普通消息只保存；人类 @ 托管成员才入队。外部成员收到 agent.wake.requested，由其自身或 runner 响应。", 14, False),
    (40, 630, "自动讨论", 16, True),
    (40, 665, "每轮共享快照；本轮全部成功后才进入下一轮。轮次、响应数或截止时间到达即结束。", 14, False),
    (40, 1055, "应用重启：保留历史和排队任务；活动运行标记 interrupted，活动讨论停止，不盲目重跑正在写文件的请求。", 13, False),
]

PAGES = [overview, execution, flow]


def font(size=13, bold=False):
    return ImageFont.truetype(str(BOLD_PATH if bold else FONT_PATH), size)


def wrap(label, width, size=13):
    face = font(size)
    lines = []
    for paragraph in label.split("\n"):
        line = ""
        for char in paragraph:
            if line and face.getlength(line + char) > width:
                lines.append(line)
                line = char
            else:
                line += char
        lines.append(line)
    return lines


def node_text(node):
    for size in [12, 11]:
        lines = wrap(node.label, node.w-16, size)
        if len(lines) <= 3:
            return size, lines
    raise ValueError(f"Node needs shorter labels: {node.id}: {lines}")


def xml_document():
    file = ET.Element("mxfile", {"host":"app.diagrams.net", "type":"device", "version":"24.7.17"})
    for page in PAGES:
        diagram = ET.SubElement(file, "diagram", {"id":page.id, "name":page.title})
        model = ET.SubElement(diagram,"mxGraphModel",{"dx":str(page.width),"dy":str(page.height),"grid":"1","gridSize":"10","page":"1","pageWidth":str(page.width),"pageHeight":str(page.height),"background":"#FFFFFF","adaptiveColors":"auto"})
        root=ET.SubElement(model,"root");ET.SubElement(root,"mxCell",{"id":"0"});ET.SubElement(root,"mxCell",{"id":"1","parent":"0"})
        def rect(id,label,x,y,w,h,style):
            cell=ET.SubElement(root,"mxCell",{"id":id,"value":label,"style":style,"vertex":"1","parent":"1"})
            ET.SubElement(cell,"mxGeometry",{"x":str(x),"y":str(y),"width":str(w),"height":str(h),"as":"geometry"})
        text_style="text;html=0;align=left;verticalAlign=middle;whiteSpace=wrap;overflow=hidden;fontFamily=Microsoft YaHei;fontColor=#172B45;"
        rect("title",page.title,40,22,page.width-80,40,text_style+"fontSize=27;fontStyle=1;")
        rect("subtitle",page.subtitle+"  |  "+STAMP+" CST",40,72,page.width-80,24,text_style+"fontSize=13;fontColor=#64748B;")
        for i,(x,y,w,h,title) in enumerate(page.groups):
            rect(f"group{i}",title,x,y,w,h,"rounded=1;arcSize=8;html=0;whiteSpace=wrap;verticalAlign=top;align=left;spacingTop=10;spacingLeft=14;fontFamily=Microsoft YaHei;fontSize=14;fontStyle=1;fontColor=#52637B;fillColor=#F8FAFC;strokeColor=#DCE3EC;container=0;")
        for node in page.nodes:
            fill,stroke=COLORS[node.tone]
            shape="shape=cylinder3;size=10;" if node.shape=="db" else "rounded=1;arcSize=12;"
            text_size,_=node_text(node)
            rect(node.id,node.label,node.x,node.y,node.w,node.h,shape+f"whiteSpace=wrap;html=0;fontFamily=Microsoft YaHei;fontSize={text_size};fontColor=#172B45;fillColor={fill};strokeColor={stroke};strokeWidth=1.3;spacing=6;")
        for i,edge in enumerate(page.edges):
            style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=0;endArrow=block;endFill=1;strokeColor=#60738A;strokeWidth=1.4;fontFamily=Microsoft YaHei;fontSize=11;fontColor=#465B73;labelBackgroundColor=#FFFFFF;"
            if edge.dashed:style+="dashed=1;dashPattern=5 4;"
            if edge.both:style+="startArrow=block;startFill=1;"
            ports={"left":(0,.5),"right":(1,.5),"top":(.5,0),"bottom":(.5,1)}
            for side,prefix in [(edge.start,"exit"),(edge.end,"entry")]:
                if side:
                    px,py=ports[side];style+=f"{prefix}X={px};{prefix}Y={py};{prefix}Dx=0;{prefix}Dy=0;"
            cell=ET.SubElement(root,"mxCell",{"id":f"edge{i}","value":edge.label,"style":style,"edge":"1","source":edge.source,"target":edge.target,"parent":"1"})
            ET.SubElement(cell,"mxGeometry",{"relative":"1","as":"geometry"})
        for i,(x,y,text,size,bold) in enumerate(page.notes):
            width=min(1360,page.width-x-30)
            if page is overview and x==40:width=300
            if page is overview and x==1120:width=300
            rect(f"note{i}",text,x,y,width,95 if "\n" in text else 28,text_style+f"fontSize={size};fontStyle={1 if bold else 0};verticalAlign=top;")
    return ET.tostring(file,encoding="utf-8",xml_declaration=True)


def port(node, side):
    return {"left":(node.x,node.y+node.h//2),"right":(node.x+node.w,node.y+node.h//2),"top":(node.x+node.w//2,node.y),"bottom":(node.x+node.w//2,node.y+node.h)}[side]


def route(page, edge):
    nodes={n.id:n for n in page.nodes};a,b=nodes[edge.source],nodes[edge.target]
    dx=b.x-a.x;dy=b.y-a.y
    default=("right","left") if abs(dx)>abs(dy) else ("bottom","top")
    if abs(dx)>abs(dy) and dx<0:default=("left","right")
    if abs(dx)<=abs(dy) and dy<0:default=("top","bottom")
    start_side,end_side=edge.start or default[0],edge.end or default[1]
    p,q=port(a,start_side),port(b,end_side)
    shifts={"left":(-20,0),"right":(20,0),"top":(0,-20),"bottom":(0,20)}
    sp=(p[0]+shifts[start_side][0],p[1]+shifts[start_side][1]);ep=(q[0]+shifts[end_side][0],q[1]+shifts[end_side][1])
    blocked=set()
    for n in page.nodes:
        for x in range(math.floor((n.x-9)/10)*10,math.ceil((n.x+n.w+9)/10)*10+1,10):
            for y in range(math.floor((n.y-9)/10)*10,math.ceil((n.y+n.h+9)/10)*10+1,10):blocked.add((x,y))
    blocked.discard(sp);blocked.discard(ep)
    queue=[(0,0,sp,None)];cost={(sp,None):0};previous={};target=None
    while queue:
        _,g,current,last=heappop(queue)
        state=(current,last)
        if g!=cost.get(state):continue
        if current==ep:target=state;break
        for direction,(sx,sy) in enumerate([(10,0),(-10,0),(0,10),(0,-10)]):
            point=(current[0]+sx,current[1]+sy)
            if not 15<=point[0]<=page.width-15 or not 110<=point[1]<=page.height-30 or point in blocked:continue
            step=g+10+(14 if last is not None and last!=direction else 0)
            next_state=(point,direction)
            if step<cost.get(next_state,1e20):
                cost[next_state]=step;previous[next_state]=state
                distance=abs(point[0]-ep[0])+abs(point[1]-ep[1])
                heappush(queue,(step+distance,step,point,direction))
    if target is None:raise ValueError(f"Cannot route {page.id}: {edge.source} -> {edge.target}")
    path=[]
    while True:
        path.append(target[0])
        if target not in previous:break
        target=previous[target]
    path.reverse();path=[p]+path+[q]
    compact=[path[0]]
    for i in range(1,len(path)-1):
        prev,point,nxt=compact[-1],path[i],path[i+1]
        if (prev[0]==point[0]==nxt[0]) or (prev[1]==point[1]==nxt[1]):continue
        compact.append(point)
    compact.append(path[-1]);return compact


def render(page):
    scale=2
    image=Image.new("RGB",(page.width*scale,page.height*scale),"white");draw=ImageDraw.Draw(image)
    svg=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{page.width}" height="{page.height}" viewBox="0 0 {page.width} {page.height}">', '<rect width="100%" height="100%" fill="#fff"/>']
    def box(x,y,w,h,fill,stroke,radius=10):
        draw.rounded_rectangle((x*scale,y*scale,(x+w)*scale,(y+h)*scale),radius=radius*scale,fill=fill,outline=stroke,width=2)
        svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}" stroke-width="1.2"/>')
    def text(x,y,content,size=13,bold=False,color="#172B45",center=False):
        draw.text((x*scale,y*scale),content,font=font(size*scale,bold),fill=color,anchor="mt" if center else "lt")
        anchor='middle' if center else 'start'
        svg.append(f'<text x="{x}" y="{y+size}" text-anchor="{anchor}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="{size}" font-weight="{600 if bold else 400}" fill="{color}">{html.escape(content)}</text>')
    text(40,25,page.title,27,True)
    text(40,77,page.subtitle+"  |  "+STAMP+" CST",13,color="#64748B")
    for x,y,w,h,title in page.groups:
        box(x,y,w,h,"#F8FAFC","#DCE3EC",9);text(x+14,y+10,title,14,True,"#52637B")
    paths=[]
    def line_segment(p,q,dashed=False):
        if not dashed:draw.line((p[0]*scale,p[1]*scale,q[0]*scale,q[1]*scale),fill="#60738A",width=3);return
        length=math.dist(p,q);count=max(1,math.ceil(length/9))
        for i in range(count):
            t0=min(i*9/length,1);t1=min((i*9+5)/length,1)
            draw.line(tuple(v*scale for v in (p[0]+(q[0]-p[0])*t0,p[1]+(q[1]-p[1])*t0,p[0]+(q[0]-p[0])*t1,p[1]+(q[1]-p[1])*t1)),fill="#60738A",width=3)
    def arrow(p,q):
        angle=math.atan2(q[1]-p[1],q[0]-p[0]);length=8
        points=[q,(q[0]-length*math.cos(angle-.45),q[1]-length*math.sin(angle-.45)),(q[0]-length*math.cos(angle+.45),q[1]-length*math.sin(angle+.45))]
        draw.polygon([(x*scale,y*scale) for x,y in points],fill="#60738A")
        svg.append('<polygon points="'+' '.join(f'{x:.1f},{y:.1f}' for x,y in points)+'" fill="#60738A"/>')
    for edge in page.edges:
        points=route(page,edge);paths.append((edge,points))
        for p,q in zip(points,points[1:]):line_segment(p,q,edge.dashed)
        dash=' stroke-dasharray="5 4"' if edge.dashed else ''
        svg.append('<polyline points="'+' '.join(f'{x},{y}' for x,y in points)+f'" fill="none" stroke="#60738A" stroke-width="1.4"{dash}/>' )
        arrow(points[-2],points[-1])
        if edge.both:arrow(points[1],points[0])
    for node in page.nodes:
        fill,stroke=COLORS[node.tone];box(node.x,node.y,node.w,node.h,fill,stroke,8)
        if node.shape=="db":
            draw.ellipse((node.x*scale,node.y*scale,(node.x+node.w)*scale,(node.y+14)*scale),fill=fill,outline=stroke,width=2)
            svg.append(f'<ellipse cx="{node.x+node.w/2}" cy="{node.y+7}" rx="{node.w/2}" ry="7" fill="{fill}" stroke="{stroke}"/>')
        text_size,lines=node_text(node)
        top=node.y+(node.h-len(lines)*16)/2
        for i,part in enumerate(lines):text(node.x+node.w/2,top+i*16,part,text_size,center=True)
    for edge,points in paths:
        if not edge.label:continue
        segments=list(zip(points,points[1:]));p,q=max(segments,key=lambda pair:math.dist(*pair))
        x,y=(p[0]+q[0])/2,(p[1]+q[1])/2
        width=font(11).getlength(edge.label)+12
        box(x-width/2,y-9,width,20,"#FFFFFF","#FFFFFF",3);text(x,y-7,edge.label,11,center=True,color="#465B73")
    for x,y,content,size,bold in page.notes:
        for i,part in enumerate(content.split("\n")):text(x,y+i*(size+9),part,size,bold,color="#52637B")
    svg.append('</svg>')
    (OUT/f"{page.id}.svg").write_text('\n'.join(svg),encoding="utf-8")
    image.save(OUT/f"{page.id}.png",optimize=True)


def main():
    OUT.mkdir(exist_ok=True)
    (OUT/"tempt-room-architecture.drawio").write_bytes(xml_document())
    for page in PAGES:render(page)
    sources=["apps/web/src/main.tsx","apps/server/src/main.ts","apps/server/src/app.ts","apps/server/src/service.ts","apps/server/src/store.ts","apps/server/src/worker.ts","apps/server/src/adapters.ts","apps/server/src/acp.ts","apps/server/src/host.ts","apps/server/src/sandbox.ts","apps/server/src/runtime.ts","apps/server/src/toolchain.ts","apps/server/src/context.ts","apps/server/src/sessions.ts","apps/server/src/workspaces.ts","apps/server/src/network.ts","apps/server/src/agent-tokens.ts","apps/server/src/session-token.ts","packages/client/src/index.ts","packages/protocol/src/index.ts","packages/protocol/src/models.ts","scripts/room-agent-mcp.mjs","scripts/room-agent-runner.mjs","scripts/room-bridge.mjs","sandbox/RoomSandbox/Program.cs","sandbox/RoomSandbox/SandboxProcess.cs","sandbox/RoomSandbox/RoomPipe.cs"]
    evidence={"generatedAtShanghai":STAMP,"scope":"local source, not a deployment or acceptance claim","sources":[{"path":path,"sha256":sha256((ROOT/path).read_bytes()).hexdigest()} for path in sources],"pages":[{"id":p.id,"title":p.title,"nodes":len(p.nodes),"edges":len(p.edges),"width":p.width,"height":p.height} for p in PAGES]}
    (OUT/"source-snapshot.json").write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+'\n',encoding="utf-8")
    print(json.dumps({"drawio":str(OUT/"tempt-room-architecture.drawio"),"pages":evidence["pages"]},ensure_ascii=False,indent=2))


if __name__=="__main__":main()
