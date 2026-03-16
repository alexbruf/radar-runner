import { defineComponent, h } from 'vue';
import './radar-runner-shell';

export const RadarRunner = defineComponent({
  name: 'RadarRunner',
  props: {
    colorMode: { type: String as () => 'dark' | 'light', default: undefined },
    width: { type: Number, default: undefined },
    height: { type: Number, default: undefined },
    collapsed: { type: Boolean, default: false },
  },
  setup(props, { slots }) {
    return () =>
      h(
        'radar-runner',
        {
          'color-mode': props.colorMode,
          width: props.width?.toString(),
          height: props.height?.toString(),
          collapsed: props.collapsed ? '' : undefined,
        },
        slots.default?.(),
      );
  },
});
