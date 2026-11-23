import type { ReactElement } from "react";
import { cx } from "./classnames";

/**
 * Friendly flat illustrations of made-up people: families, mums and children, neighbours. They are decorative: every
 * piece of information they sit next to is also written as text, so they are hidden from assistive technology unless a
 * `title` is given. Colours come only from the `--k-art-*` tokens, so they follow the light and dark themes.
 * Deliberately drawn characters, never photographs: the platform does not show real children's pictures.
 */

type Skin = 1 | 2 | 3 | 4 | 5;
type HairColour = "black" | "brown" | "chestnut" | "grey";
type HairStyle = "short" | "long" | "bob" | "bun" | "curly" | "pony" | "cap";
type Outfit = "teal" | "sun" | "coral" | "grape" | "sky-blue" | "leaf" | "pink" | "navy" | "denim" | "white";
/** An angle in degrees (0 hangs down, 90 points out sideways, 180 is straight up), or a point to reach for. */
type Arm = number | { to: readonly [number, number] };
type Point = readonly [number, number];

interface Person {
  x: number;
  y: number;
  h: number;
  skin: Skin;
  hair: HairColour;
  style: HairStyle;
  top: Outfit;
  bottom?: Outfit;
  dress?: boolean;
  child?: boolean;
  armL?: Arm;
  armR?: Arm;
  smile?: "soft" | "big";
}

/** Trigonometry can differ in the last digits between the server and the browser, which React reports as a hydration mismatch; round every computed coordinate. */
const q = (v: number): number => Math.round(v * 100) / 100;

const tok = (name: string): string => `var(--k-art-${name})`;
const fill = (name: string) => ({ fill: tok(name) });
const stroke = (name: string) => ({ stroke: tok(name) });

function dims(p: Person) {
  const child = p.child ?? false;
  const r = p.h * (child ? 0.19 : 0.135);
  const neckY = -p.h + 2 * r;
  const shoulderY = neckY + p.h * 0.03;
  const torsoLen = p.h * (child ? 0.3 : 0.31);
  return {
    r,
    cy: -p.h + r,
    neckY,
    shoulderY,
    torsoLen,
    hipY: shoulderY + torsoLen,
    torsoW: p.h * (child ? 0.27 : 0.23),
    armLen: p.h * (child ? 0.29 : 0.3),
  };
}

function armEnd(p: Person, side: "L" | "R", arm: Arm): Point {
  if (typeof arm !== "number") return [arm.to[0] - p.x, arm.to[1] - p.y];
  const d = dims(p);
  const sign = side === "L" ? -1 : 1;
  const rad = (arm * Math.PI) / 180;
  return [q(sign * d.torsoW * 0.46 + sign * d.armLen * Math.sin(rad)), q(d.shoulderY + p.h * 0.035 + d.armLen * Math.cos(rad))];
}

/** Where a person's hand is, in scene coordinates (to hang a balloon or a kite string from it). */
function hand(p: Person, side: "L" | "R"): Point {
  const e = armEnd(p, side, (side === "L" ? p.armL : p.armR) ?? 14);
  return [p.x + e[0], p.y + e[1]];
}

function Limb({ p, side, arm }: { p: Person; side: "L" | "R"; arm: Arm }) {
  const d = dims(p);
  const sign = side === "L" ? -1 : 1;
  const sx = sign * d.torsoW * 0.46;
  const sy = d.shoulderY + p.h * 0.035;
  const [ex, ey] = armEnd(p, side, arm);
  const mx = sx + (ex - sx) * 0.4;
  const my = sy + (ey - sy) * 0.4;
  return (
    <g strokeLinecap="round">
      <line x1={sx} y1={sy} x2={ex} y2={ey} strokeWidth={p.h * 0.062} style={stroke(`skin-${p.skin}`)} />
      <line x1={sx} y1={sy} x2={mx} y2={my} strokeWidth={p.h * 0.078} style={stroke(p.top)} />
      <circle cx={ex} cy={ey} r={p.h * 0.04} style={fill(`skin-${p.skin}`)} />
    </g>
  );
}

function HairBack({ p }: { p: Person }) {
  const { r, cy } = dims(p);
  const colour = fill(`hair-${p.hair}`);
  if (p.style === "long") return <rect x={-1.12 * r} y={cy - 0.3 * r} width={2.24 * r} height={2.3 * r} rx={0.7 * r} style={colour} />;
  if (p.style === "bob") return <rect x={-1.12 * r} y={cy - 0.3 * r} width={2.24 * r} height={1.55 * r} rx={0.65 * r} style={colour} />;
  if (p.style === "pony")
    return (
      <g>
        <ellipse cx={1.22 * r} cy={cy + 0.45 * r} rx={0.3 * r} ry={0.68 * r} transform={`rotate(-14 ${1.1 * r} ${cy})`} style={colour} />
      </g>
    );
  return null;
}

function HairFront({ p }: { p: Person }) {
  const { r, cy } = dims(p);
  const colour = fill(`hair-${p.hair}`);
  const short = `M ${-1.06 * r} ${cy + 0.08 * r} A ${1.06 * r} ${1.06 * r} 0 0 1 ${1.06 * r} ${cy + 0.08 * r} Q ${0.55 * r} ${cy - 0.5 * r} ${-0.1 * r} ${cy - 0.3 * r} Q ${-0.6 * r} ${cy - 0.12 * r} ${-1.06 * r} ${cy + 0.08 * r} Z`;
  if (p.style === "curly") {
    const angles = [-170, -150, -130, -110, -90, -70, -50, -30, -10];
    return (
      <g style={colour}>
        {angles.map((a) => (
          <circle key={a} cx={q(Math.cos((a * Math.PI) / 180) * r * 0.98)} cy={q(cy + Math.sin((a * Math.PI) / 180) * r * 0.98)} r={r * 0.36} />
        ))}
        <path d={short} />
      </g>
    );
  }
  return (
    <g>
      <path d={short} style={colour} />
      {p.style === "bun" && <circle cx={0} cy={cy - 1.12 * r} r={0.42 * r} style={colour} />}
      {p.style === "pony" && <circle cx={1.0 * r} cy={cy - 0.1 * r} r={0.11 * r} style={fill("coral")} />}
      {p.style === "cap" && (
        <g style={fill(p.top)}>
          <path d={`M ${-1.1 * r} ${cy - 0.02 * r} A ${1.1 * r} ${1.1 * r} 0 0 1 ${1.1 * r} ${cy - 0.02 * r} Z`} />
          <ellipse cx={0.92 * r} cy={cy - 0.04 * r} rx={0.78 * r} ry={0.14 * r} />
        </g>
      )}
    </g>
  );
}

function PersonArt(p: Person) {
  const d = dims(p);
  const child = p.child ?? false;
  const bottom = p.bottom ?? (child ? "navy" : "denim");
  const legX = d.torsoW * 0.2;
  const hem = d.hipY + p.h * (child ? 0.12 : 0.16);
  const tw = d.torsoW;
  const smile = p.smile ?? "soft";
  return (
    <g transform={`translate(${p.x} ${p.y})`}>
      <HairBack p={p} />
      {/* legs and shoes */}
      {[-1, 1].map((s) => (
        <g key={s}>
          <line
            x1={s * legX}
            y1={p.dress ? hem - 2 : d.hipY}
            x2={s * legX}
            y2={-p.h * 0.04}
            strokeLinecap="round"
            strokeWidth={p.dress ? p.h * 0.055 : p.h * (child ? 0.1 : 0.085)}
            style={stroke(p.dress ? `skin-${p.skin}` : bottom)}
          />
          <ellipse cx={s * (legX + p.h * 0.012)} cy={-p.h * 0.02} rx={p.h * 0.065} ry={p.h * 0.03} style={fill("shoe")} />
        </g>
      ))}
      {/* body */}
      {p.dress ? (
        <path
          d={`M ${-tw / 2} ${d.shoulderY} L ${tw / 2} ${d.shoulderY} L ${tw * 0.92} ${hem} L ${-tw * 0.92} ${hem} Z`}
          strokeLinejoin="round"
          strokeWidth={p.h * 0.04}
          style={{ ...fill(p.top), ...stroke(p.top) }}
        />
      ) : (
        <rect x={-tw / 2} y={d.shoulderY} width={tw} height={d.torsoLen + p.h * 0.03} rx={tw * 0.38} style={fill(p.top)} />
      )}
      <Limb p={p} side="L" arm={p.armL ?? 14} />
      <Limb p={p} side="R" arm={p.armR ?? 14} />
      {/* neck, head, face */}
      <rect x={-d.r * 0.28} y={d.neckY - d.r * 0.3} width={d.r * 0.56} height={d.r * 0.7} style={fill(`skin-${p.skin}`)} />
      <circle cx={0} cy={d.cy} r={d.r} style={fill(`skin-${p.skin}`)} />
      <circle cx={-d.r * 0.55} cy={d.cy + d.r * 0.38} r={d.r * 0.16} opacity={0.3} style={fill("cheek")} />
      <circle cx={d.r * 0.55} cy={d.cy + d.r * 0.38} r={d.r * 0.16} opacity={0.3} style={fill("cheek")} />
      <circle cx={-d.r * 0.36} cy={d.cy + d.r * 0.05} r={d.r * 0.09} style={fill("ink")} />
      <circle cx={d.r * 0.36} cy={d.cy + d.r * 0.05} r={d.r * 0.09} style={fill("ink")} />
      {smile === "big" ? (
        <path d={`M ${-d.r * 0.36} ${d.cy + d.r * 0.3} Q 0 ${d.cy + d.r * 0.95} ${d.r * 0.36} ${d.cy + d.r * 0.3} Z`} style={fill("ink")} />
      ) : (
        <path d={`M ${-d.r * 0.3} ${d.cy + d.r * 0.38} Q 0 ${d.cy + d.r * 0.68} ${d.r * 0.3} ${d.cy + d.r * 0.38}`} fill="none" strokeLinecap="round" strokeWidth={d.r * 0.09} style={stroke("ink")} />
      )}
      <HairFront p={p} />
    </g>
  );
}

/* ----------------------------------------------------------------- scenery */

function Backdrop({ w, h, ground = h - 60 }: { w: number; h: number; ground?: number }) {
  return (
    <g>
      <rect width={w} height={h} rx={28} style={fill("sky")} />
      <path d={`M0 ${ground - 40} Q ${w * 0.18} ${ground - 100} ${w * 0.36} ${ground - 50} T ${w * 0.74} ${ground - 55} T ${w} ${ground - 70} V ${h} H0 Z`} style={fill("hill")} />
      <path d={`M0 ${ground} Q ${w / 2} ${ground - 34} ${w} ${ground} V ${h - 28} Q ${w} ${h} ${w - 28} ${h} H 28 Q 0 ${h} 0 ${h - 28} Z`} style={fill("ground")} />
    </g>
  );
}

function Sun({ x, y, r }: { x: number; y: number; r: number }) {
  return (
    <g>
      {Array.from({ length: 10 }, (_, i) => {
        const a = (i * 36 * Math.PI) / 180;
        return <line key={i} x1={q(x + Math.cos(a) * (r + 6))} y1={q(y + Math.sin(a) * (r + 6))} x2={q(x + Math.cos(a) * (r + 14))} y2={q(y + Math.sin(a) * (r + 14))} strokeLinecap="round" strokeWidth={4} style={stroke("sunball")} />;
      })}
      <circle cx={x} cy={y} r={r} style={fill("sunball")} />
    </g>
  );
}

function Cloud({ x, y, s = 1 }: { x: number; y: number; s?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`} style={fill("cloud")}>
      <circle cx={0} cy={0} r={13} />
      <circle cx={18} cy={-9} r={18} />
      <circle cx={40} cy={-1} r={14} />
      <rect x={0} y={-1} width={40} height={14} rx={7} />
    </g>
  );
}

function Tree({ x, y, s = 1, leaf = "leaf" }: { x: number; y: number; s?: number; leaf?: string }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <rect x={-5} y={-40} width={10} height={44} rx={4} style={fill("hair-brown")} />
      <circle cx={0} cy={-62} r={30} style={fill(leaf)} />
      <circle cx={-22} cy={-46} r={20} style={fill(leaf)} />
      <circle cx={22} cy={-46} r={20} style={fill(leaf)} />
    </g>
  );
}

function House({ x, y, w, h, wall, roof }: { x: number; y: number; w: number; h: number; wall: string; roof: string }) {
  return (
    <g>
      <rect x={x} y={y - h} width={w} height={h} rx={4} style={fill(wall)} />
      <path d={`M ${x - 6} ${y - h + 2} L ${x + w / 2} ${y - h - w * 0.42} L ${x + w + 6} ${y - h + 2} Z`} strokeLinejoin="round" strokeWidth={4} style={{ ...fill(roof), ...stroke(roof) }} />
      <rect x={x + w / 2 - 7} y={y - h * 0.42} width={14} height={h * 0.42} rx={3} style={fill("hair-brown")} />
      <rect x={x + w * 0.12} y={y - h * 0.78} width={w * 0.22} height={w * 0.22} rx={3} style={fill("sky")} />
      <rect x={x + w * 0.66} y={y - h * 0.78} width={w * 0.22} height={w * 0.22} rx={3} style={fill("sky")} />
    </g>
  );
}

function Balloon({ from, dx, dy, colour }: { from: Point; dx: number; dy: number; colour: string }) {
  const cx = from[0] + dx;
  const cy = from[1] + dy;
  return (
    <g>
      <path d={`M ${from[0]} ${from[1]} Q ${from[0] + dx * 0.2} ${from[1] + dy * 0.5} ${cx} ${cy + 22}`} fill="none" strokeWidth={1.6} style={stroke("ink")} opacity={0.6} />
      <ellipse cx={cx} cy={cy} rx={17} ry={21} style={fill(colour)} />
      <path d={`M ${cx - 4} ${cy + 20} L ${cx + 4} ${cy + 20} L ${cx} ${cy + 26} Z`} style={fill(colour)} />
      <ellipse cx={cx - 6} cy={cy - 8} rx={3.5} ry={6} opacity={0.35} transform={`rotate(25 ${cx - 6} ${cy - 8})`} style={fill("white")} />
    </g>
  );
}

function Kite({ x, y, s, from }: { x: number; y: number; s: number; from: Point }) {
  return (
    <g>
      <path d={`M ${from[0]} ${from[1]} Q ${(from[0] + x) / 2 + 24} ${(from[1] + y) / 2 + 30} ${x} ${y + s * 1.2}`} fill="none" strokeWidth={1.6} style={stroke("ink")} opacity={0.6} />
      <polygon points={`${x},${y - s} ${x + s * 0.7},${y} ${x},${y + s * 1.2} ${x - s * 0.7},${y}`} style={fill("coral")} />
      <polygon points={`${x},${y - s} ${x + s * 0.7},${y} ${x},${y}`} style={fill("sun")} />
      <polygon points={`${x},${y} ${x - s * 0.7},${y} ${x},${y + s * 1.2}`} style={fill("grape")} />
      <path d={`M ${x} ${y + s * 1.2} q 10 12 -2 22 q -12 10 4 22`} fill="none" strokeWidth={2.4} strokeLinecap="round" style={stroke("grape")} />
    </g>
  );
}

function Ball({ x, y, r }: { x: number; y: number; r: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r={r} style={fill("white")} />
      <path d={`M ${x - r} ${y} Q ${x} ${y - r * 0.9} ${x + r} ${y}`} fill="none" strokeWidth={r * 0.28} style={stroke("coral")} />
      <path d={`M ${x - r * 0.7} ${y + r * 0.72} Q ${x} ${y + r * 0.1} ${x + r * 0.7} ${y + r * 0.72}`} fill="none" strokeWidth={r * 0.28} style={stroke("sky-blue")} />
    </g>
  );
}

function Star({ x, y, r, colour }: { x: number; y: number; r: number; colour: string }) {
  const pts = Array.from({ length: 10 }, (_, i) => {
    const a = (-90 + i * 36) * (Math.PI / 180);
    const rad = i % 2 === 0 ? r : r * 0.45;
    return `${q(x + Math.cos(a) * rad)},${q(y + Math.sin(a) * rad)}`;
  }).join(" ");
  return <polygon points={pts} strokeLinejoin="round" strokeWidth={2} style={{ ...fill(colour), ...stroke(colour) }} />;
}

function Flower({ x, y, colour }: { x: number; y: number; colour: string }) {
  return (
    <g>
      <line x1={x} y1={y} x2={x} y2={y + 16} strokeWidth={2.5} strokeLinecap="round" style={stroke("leaf")} />
      {[0, 72, 144, 216, 288].map((a) => (
        <circle key={a} cx={q(x + Math.cos((a * Math.PI) / 180) * 5)} cy={q(y + Math.sin((a * Math.PI) / 180) * 5)} r={4} style={fill(colour)} />
      ))}
      <circle cx={x} cy={y} r={3} style={fill("sunball")} />
    </g>
  );
}

const CONFETTI: [number, number, number, string][] = [
  [40, 50, 20, "coral"], [90, 28, -30, "sun"], [140, 62, 40, "sky-blue"], [220, 30, 10, "grape"], [270, 66, -20, "leaf"],
  [320, 36, 35, "coral"], [60, 110, -10, "leaf"], [310, 110, 25, "sun"], [24, 168, 15, "grape"], [338, 170, -35, "sky-blue"],
  [112, 88, 50, "pink"], [250, 96, -45, "pink"],
];

/* ------------------------------------------------------------------ scenes */

type Scene = { w: number; h: number; draw: () => ReactElement };

const family = (): ReactElement => {
  const mum: Person = { x: 215, y: 366, h: 172, skin: 3, hair: "black", style: "long", top: "coral", dress: true, armL: { to: [180, 305] }, armR: { to: [268, 296] }, smile: "big" };
  const dad: Person = { x: 322, y: 366, h: 184, skin: 2, hair: "brown", style: "short", top: "sky-blue", bottom: "navy", armL: { to: [268, 296] }, armR: { to: [356, 292] } };
  const girl: Person = { x: 135, y: 368, h: 104, skin: 3, hair: "black", style: "pony", top: "teal", dress: true, child: true, armL: 60, armR: { to: [180, 305] }, smile: "big" };
  const boy: Person = { x: 396, y: 368, h: 112, skin: 2, hair: "brown", style: "curly", top: "leaf", child: true, armL: { to: [356, 292] }, armR: 150, smile: "big" };
  const boyHand = hand(boy, "R");
  return (
    <g>
      <Backdrop w={600} h={400} ground={338} />
      <circle cx={300} cy={235} r={175} style={fill("blob-a")} />
      <circle cx={118} cy={140} r={64} style={fill("blob-b")} />
      <Sun x={510} y={84} r={32} />
      <Cloud x={70} y={78} />
      <Cloud x={380} y={64} s={0.8} />
      <Tree x={58} y={340} s={1.1} />
      <Tree x={548} y={336} s={1} leaf="teal" />
      <PersonArt {...girl} />
      <PersonArt {...mum} />
      <PersonArt {...dad} />
      <PersonArt {...boy} />
      <Balloon from={boyHand} dx={16} dy={-110} colour="coral" />
      <Balloon from={boyHand} dx={-14} dy={-84} colour="grape" />
      <Balloon from={boyHand} dx={42} dy={-78} colour="sun" />
      <Flower x={470} y={372} colour="pink" />
      <Flower x={492} y={378} colour="sun" />
      <Flower x={30} y={376} colour="coral" />
    </g>
  );
};

const mumAndChild = (): ReactElement => {
  const mum: Person = { x: 138, y: 268, h: 170, skin: 4, hair: "black", style: "bun", top: "grape", dress: true, armR: { to: [178, 200] }, smile: "big" };
  const kid: Person = { x: 212, y: 270, h: 98, skin: 4, hair: "black", style: "curly", top: "sun", child: true, armL: { to: [178, 200] }, armR: 150, smile: "big" };
  const kidHand = hand(kid, "R");
  return (
    <g>
      <Backdrop w={360} h={300} ground={252} />
      <circle cx={190} cy={150} r={118} style={fill("blob-a")} />
      <Sun x={56} y={52} r={22} />
      <Cloud x={150} y={56} s={0.7} />
      <Kite x={296} y={78} s={30} from={kidHand} />
      <PersonArt {...mum} />
      <PersonArt {...kid} />
      <Flower x={46} y={262} colour="coral" />
      <Flower x={316} y={268} colour="pink" />
      <Flower x={332} y={258} colour="sun" />
    </g>
  );
};

const kids = (): ReactElement => {
  const a: Person = { x: 104, y: 272, h: 134, skin: 2, hair: "brown", style: "short", top: "teal", child: true, armL: 45, armR: 70, smile: "big" };
  const b: Person = { x: 240, y: 274, h: 146, skin: 5, hair: "black", style: "curly", top: "coral", child: true, armL: 155, armR: 155, smile: "big" };
  const c: Person = { x: 372, y: 272, h: 132, skin: 1, hair: "chestnut", style: "pony", top: "grape", dress: true, child: true, armL: 16, armR: { to: [408, 214] }, smile: "big" };
  return (
    <g>
      <Backdrop w={480} h={300} ground={252} />
      <circle cx={240} cy={160} r={128} style={fill("blob-b")} />
      <Sun x={420} y={56} r={24} />
      <Cloud x={60} y={60} s={0.9} />
      <Tree x={448} y={256} s={0.8} />
      <PersonArt {...a} />
      <Ball x={172} y={262} r={16} />
      <PersonArt {...b} />
      <PersonArt {...c} />
      <g transform="rotate(-8 416 206)">
        <rect x={396} y={186} width={46} height={58} rx={4} style={fill("white")} />
        <path d="M 404 200 q 6 -8 12 0 t 12 0 M 404 214 l 28 0 M 404 226 q 12 -8 24 0" fill="none" strokeWidth={3} strokeLinecap="round" style={stroke("coral")} />
      </g>
    </g>
  );
};

const community = (): ReactElement => {
  const grandma: Person = { x: 112, y: 274, h: 150, skin: 3, hair: "grey", style: "bun", top: "pink", dress: true, armR: 150, smile: "big" };
  const man: Person = { x: 202, y: 276, h: 178, skin: 4, hair: "black", style: "short", top: "teal", bottom: "navy" };
  const woman: Person = { x: 296, y: 276, h: 166, skin: 2, hair: "brown", style: "bob", top: "sun", bottom: "denim", armL: 150, smile: "big" };
  const boy: Person = { x: 380, y: 278, h: 100, skin: 3, hair: "black", style: "cap", top: "sky-blue", child: true, armR: 150, smile: "big" };
  const girl: Person = { x: 440, y: 278, h: 96, skin: 5, hair: "black", style: "curly", top: "leaf", dress: true, child: true, smile: "big" };
  return (
    <g>
      <Backdrop w={520} h={300} ground={252} />
      <Sun x={462} y={52} r={22} />
      <Cloud x={70} y={58} s={0.9} />
      <Cloud x={290} y={42} s={0.7} />
      <House x={50} y={236} w={74} h={62} wall="sun" roof="coral" />
      <House x={170} y={232} w={92} h={80} wall="white" roof="teal" />
      <House x={340} y={236} w={80} h={66} wall="pink" roof="grape" />
      <Tree x={30} y={262} s={0.7} />
      <Tree x={492} y={262} s={0.75} leaf="teal" />
      <PersonArt {...grandma} />
      <PersonArt {...man} />
      <PersonArt {...woman} />
      <PersonArt {...boy} />
      <PersonArt {...girl} />
    </g>
  );
};

const celebrate = (): ReactElement => {
  const kid: Person = { x: 180, y: 262, h: 132, skin: 3, hair: "black", style: "short", top: "sun", bottom: "coral", child: true, armL: 160, armR: 160, smile: "big" };
  return (
    <g>
      <rect width={360} height={280} rx={28} style={fill("sky")} />
      <circle cx={180} cy={140} r={120} style={fill("blob-a")} />
      <path d="M0 230 Q 180 200 360 230 V 252 Q 360 280 332 280 H 28 Q 0 280 0 252 Z" style={fill("ground")} />
      {CONFETTI.map(([x, y, rot, c], i) => (
        <rect key={i} x={x} y={y} width={10} height={5} rx={1.5} transform={`rotate(${rot} ${x + 5} ${y + 2.5})`} style={fill(c)} />
      ))}
      <Star x={78} y={78} r={13} colour="sun" />
      <Star x={288} y={92} r={11} colour="pink" />
      <Star x={300} y={40} r={8} colour="sky-blue" />
      <PersonArt {...kid} />
    </g>
  );
};

const explore = (): ReactElement => {
  const kid: Person = { x: 130, y: 262, h: 132, skin: 4, hair: "black", style: "curly", top: "teal", bottom: "navy", child: true, armL: 14, armR: 125, smile: "big" };
  const [hx, hy] = hand(kid, "R");
  return (
    <g>
      <Backdrop w={360} h={280} ground={236} />
      <circle cx={200} cy={140} r={110} style={fill("blob-b")} />
      <Cloud x={60} y={52} s={0.8} />
      <Sun x={314} y={50} r={20} />
      {/* a little market stall */}
      <rect x={236} y={166} width={96} height={70} rx={4} style={fill("hair-brown")} />
      {[0, 1, 2, 3].map((i) => (
        <path key={i} d={`M ${230 + i * 25} 120 L ${230 + (i + 1) * 25} 120 L ${236 + (i + 1) * 24} 160 L ${236 + i * 24} 160 Z`} style={fill(i % 2 === 0 ? "coral" : "white")} />
      ))}
      <rect x={244} y={196} width={80} height={10} rx={3} style={fill("white")} />
      <Ball x={262} y={186} r={10} />
      <rect x={284} y={174} width={14} height={20} rx={2} style={fill("grape")} />
      <rect x={302} y={178} width={14} height={16} rx={2} style={fill("sun")} />
      <PersonArt {...kid} />
      <circle cx={hx + 22} cy={hy - 20} r={22} opacity={0.55} style={fill("white")} />
      <circle cx={hx + 22} cy={hy - 20} r={22} fill="none" strokeWidth={5} style={stroke("navy")} />
      <line x1={hx + 6} y1={hy - 4} x2={hx - 2} y2={hy + 4} strokeWidth={7} strokeLinecap="round" style={stroke("navy")} />
    </g>
  );
};

const stepIdea = (): ReactElement => {
  const kid: Person = { x: 110, y: 140, h: 86, skin: 2, hair: "brown", style: "short", top: "coral", child: true, armR: 150, smile: "big" };
  return (
    <g>
      <circle cx={110} cy={78} r={62} style={fill("blob-a")} />
      <ellipse cx={110} cy={138} rx={86} ry={9} style={fill("ground")} />
      {Array.from({ length: 7 }, (_, i) => {
        const a = (-150 + i * 20) * (Math.PI / 180);
        return <line key={i} x1={q(110 + Math.cos(a) * 22)} y1={q(30 + Math.sin(a) * 22)} x2={q(110 + Math.cos(a) * 29)} y2={q(30 + Math.sin(a) * 29)} strokeWidth={3.5} strokeLinecap="round" style={stroke("sunball")} />;
      })}
      <circle cx={110} cy={30} r={14} style={fill("sunball")} />
      <rect x={104} y={43} width={12} height={8} rx={2} style={fill("navy")} />
      <PersonArt {...kid} />
    </g>
  );
};

const stepMatch = (): ReactElement => {
  const parent: Person = { x: 80, y: 140, h: 108, skin: 3, hair: "black", style: "bob", top: "teal", dress: true, armR: { to: [110, 100] }, smile: "big" };
  const vendor: Person = { x: 140, y: 140, h: 112, skin: 4, hair: "brown", style: "short", top: "navy", bottom: "denim", armL: { to: [110, 100] }, smile: "big" };
  return (
    <g>
      <circle cx={110} cy={78} r={62} style={fill("blob-b")} />
      <ellipse cx={110} cy={138} rx={86} ry={9} style={fill("ground")} />
      <PersonArt {...parent} />
      <PersonArt {...vendor} />
      <circle cx={168} cy={36} r={15} style={fill("leaf")} />
      <path d="M 160 36 l 5.5 6 l 10 -12" fill="none" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" style={stroke("white")} />
    </g>
  );
};

const stepBook = (): ReactElement => {
  const mum: Person = { x: 148, y: 140, h: 100, skin: 5, hair: "black", style: "long", top: "grape", dress: true, armR: 150, smile: "big" };
  const kid: Person = { x: 192, y: 140, h: 62, skin: 5, hair: "black", style: "curly", top: "sun", child: true, armL: 150, smile: "big" };
  return (
    <g>
      <circle cx={110} cy={78} r={62} style={fill("blob-a")} />
      <ellipse cx={110} cy={138} rx={96} ry={9} style={fill("ground")} />
      <rect x={20} y={32} width={84} height={78} rx={10} style={fill("white")} />
      <path d="M 20 42 a 10 10 0 0 1 10 -10 h 64 a 10 10 0 0 1 10 10 v 12 h -84 Z" style={fill("teal")} />
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <circle key={i} cx={36 + (i % 4) * 18} cy={72 + Math.floor(i / 4) * 18} r={4.5} style={fill(i === 5 ? "coral" : "blob-a")} />
      ))}
      <circle cx={94} cy={98} r={13} style={fill("leaf")} />
      <path d="M 88 98 l 4.5 5 l 8.5 -10" fill="none" strokeWidth={3.6} strokeLinecap="round" strokeLinejoin="round" style={stroke("white")} />
      <PersonArt {...mum} />
      <PersonArt {...kid} />
    </g>
  );
};

const SCENES = {
  family: { w: 600, h: 400, draw: family },
  mumAndChild: { w: 360, h: 300, draw: mumAndChild },
  kids: { w: 480, h: 300, draw: kids },
  community: { w: 520, h: 300, draw: community },
  celebrate: { w: 360, h: 280, draw: celebrate },
  explore: { w: 360, h: 280, draw: explore },
  stepIdea: { w: 220, h: 150, draw: stepIdea },
  stepMatch: { w: 220, h: 150, draw: stepMatch },
  stepBook: { w: 220, h: 150, draw: stepBook },
  // Banner photo slots (2026-11-23) reuse a drawing as their stand-in until a photo is present.
  bannerCandles: { w: 360, h: 280, draw: celebrate },
  bannerBirthday: { w: 360, h: 280, draw: celebrate },
  bannerPicnic: { w: 600, h: 400, draw: family },
  bannerPark: { w: 480, h: 300, draw: kids },
} satisfies Record<string, Scene>;

export type IllustrationName = keyof typeof SCENES;

/**
 * Decorative artwork. Pass `title` only when the picture says something that the text beside it does not; otherwise it
 * is hidden from screen readers (the text next to it always carries the meaning).
 */
export function Illustration({ name, title, className }: { name: IllustrationName; title?: string; className?: string }) {
  const scene: Scene = SCENES[name];
  return (
    <svg
      viewBox={`0 0 ${scene.w} ${scene.h}`}
      className={cx("k-art", `k-art-${name}`, className)}
      xmlns="http://www.w3.org/2000/svg"
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true, focusable: "false" })}
    >
      {scene.draw()}
    </svg>
  );
}
