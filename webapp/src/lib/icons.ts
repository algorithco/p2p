import {
  BrushCleaning,
  Trash2,
  LockKeyhole,
  MessageCircle,
  Cross,
  ChevronDown,
  CircleCheckBig,
  Clock,
  BotOff,
  AlarmClock,
  ExternalLink,
  Unplug,
  Router,
  BadgeCheck,
  Copy,
  Key,
  PartyPopper,
  Search,
  Send,
} from 'lucide';

/**
 * The 18 animate-ui icon set, rendered natively (no React in this Mini App).
 * animate-ui icons ARE lucide icons + motion wrappers — here each icon renders
 * as inline SVG and animates via the `.ico-*` CSS classes in styles/app.css
 * (hover/tap/subtle loops, same feel as animate-ui, zero runtime deps).
 *
 * Usage: UI.h('button', { class: 'btn' }, [icon('circle-check-big', 'ico-pop'), ' Matn'])
 * Sizes inherit font-size: .ico { width:1.15em; height:1.15em }.
 */
type IconNode = Array<[string, Record<string, string | number>]>;

const ICONS: Record<string, IconNode> = {
  'brush-cleaning': BrushCleaning as unknown as IconNode,
  'trash-2': Trash2 as unknown as IconNode,
  'lock-keyhole': LockKeyhole as unknown as IconNode,
  'message-circle': MessageCircle as unknown as IconNode,
  cross: Cross as unknown as IconNode,
  'chevron-down': ChevronDown as unknown as IconNode,
  'circle-check-big': CircleCheckBig as unknown as IconNode,
  clock: Clock as unknown as IconNode,
  'bot-off': BotOff as unknown as IconNode,
  'alarm-clock': AlarmClock as unknown as IconNode,
  'external-link': ExternalLink as unknown as IconNode,
  unplug: Unplug as unknown as IconNode,
  router: Router as unknown as IconNode,
  'badge-check': BadgeCheck as unknown as IconNode,
  copy: Copy as unknown as IconNode,
  key: Key as unknown as IconNode,
  'party-popper': PartyPopper as unknown as IconNode,
  search: Search as unknown as IconNode,
  send: Send as unknown as IconNode,
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export function iconNames(): string[] {
  return Object.keys(ICONS);
}

/** Render a lucide icon as inline SVG. `cls` adds animation classes (ico-pop, ico-ring, …). */
export function icon(name: string, cls = ''): SVGElement {
  const node = ICONS[name];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', ('ico ' + cls).trim());
  svg.setAttribute('aria-hidden', 'true');
  if (node) {
    for (const [tag, attrs] of node) {
      try {
        const el = document.createElementNS(SVG_NS, tag);
        for (const k of Object.keys(attrs || {})) {
          if (k === 'key') continue;
          el.setAttribute(k, String((attrs as Record<string, unknown>)[k]));
        }
        svg.appendChild(el);
      } catch {
        /* skip malformed child */
      }
    }
  }
  return svg;
}

/** Helper for buttons: [icon, ' label'] children with a leading space. */
export function iconLabel(name: string, text: string, cls = ''): Array<SVGElement | string> {
  return [icon(name, cls), ' ' + text];
}
