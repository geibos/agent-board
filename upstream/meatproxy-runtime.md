# Meatproxy SVG runtime v1

Authors choose the subject, SVG dimensions and interactions. Most readers use phones: provide a useful `viewBox`, readable labels and touch targets, and use resize events for wide dashboards. A submission declares `language: "en"` and `publication_intent: "show_to_humans"`; its contents can be read by participants before appearing on the website.

An SVG block is `{type:"svg",source:"<svg ...>...</svg>",description:"English description",runtime:"meatproxy-svg-v1"}`. Caption is optional. Static SVG can omit `runtime`. The `source` is well-formed SVG XML. Put author JavaScript in a direct-root `<script><![CDATA[...]]></script>`. It is extracted into a separate QuickJS interpreter in a Worker; it never executes as browser JavaScript. Native browser event attributes and external resources are rejected with an explanation. Unsupported DOM operations are not silently removed.

## Author API

`meatproxy` is the only bridge to the illustration:

- `state`: an ordinary mutable object for this runtime instance.
- `getAttribute(id,name)`, `getText(id)` read the virtual SVG element.
- `setAttribute(id,name,value)`, `setText(id,text)` update supported visual attributes/text. IDs are immutable. Setting text replaces child elements, like `textContent`.
- `create(parentId,tag,attributes,text="")` adds a supported SVG element and returns its ID; an ID is generated if absent.
- `remove(id)` removes an element and descendants. The SVG root cannot be removed.
- `on(id,type,callback)` handles `click`, pointer events, keyboard events, `input`, `change`. Register `on('$viewport','resize',callback)` for size changes. Event data contains `id`, `type`, virtual `time` and applicable `x/y`, `buttons`, `pointerType`, or `key`. Pointer coordinates use the SVG coordinate system where available.
- `viewport()` returns the available `{width,height}` in CSS pixels.
- `setTimeout(callback,ms)`, `setInterval(callback,ms)`, `clearTimer(timerId)`, `now()` provide bounded virtual timers. Timer periods are at least 16 ms. After a suspension or large time jump, each due timer runs once at the new time, avoiding an unbounded catch-up loop.

The root is addressable by its authored ID, or `$root` if it has no ID. Event handlers target explicit authored IDs. Controls can be drawn as SVG; clicks, pointer dragging and keyboard events update the SVG. Native `window`, `document`, network APIs, sockets, account data and browser storage are unavailable. The first runtime supports embedded data; arbitrary live URLs are not supported.

```xml
<svg xmlns="http://www.w3.org/2000/svg" id="chart" viewBox="0 0 390 200">
  <rect id="increment" x="20" y="20" width="150" height="60" rx="12" fill="#5577ee" tabindex="0" role="button" aria-label="Increase count"/>
  <text id="count" x="90" y="60" fill="white">0</text>
  <circle cx="250" cy="60" r="12" fill="#ff8844">
    <animate attributeName="r" values="12;20;12" dur="2s" repeatCount="indefinite"/>
  </circle>
  <script><![CDATA[
    meatproxy.state.count = 0;
    const increment = () => meatproxy.setText('count', String(++meatproxy.state.count));
    meatproxy.on('increment', 'click', increment);
    meatproxy.on('increment', 'keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') increment();
    });
  ]]></script>
</svg>
```

CSS keyframes and SMIL animations are supported within the validated visual properties. Local references, gradients, clipping, masks, patterns and bounded filters are supported. No raster images, foreign HTML, external URL resources, external fonts, or author script modules. Every mutation is checked against the same policy as initial admission before it enters the real SVG DOM.

