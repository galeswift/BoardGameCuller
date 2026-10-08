import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useState, type CSSProperties, type ReactNode } from 'react';

// Lists shorter than this render every row; longer ones only draw the rows near the screen,
// so a collection of thousands of games stays quick to scroll and re-sort.
const VIRTUALIZE_FROM = 150;

/** Props a row spreads onto its outermost element so the windowed list can place and measure it. */
export type RowProps = { ref?: (node: Element | null) => void; 'data-index'?: number; style?: CSSProperties };

type Props<Item> = {
    items: Item[];
    rowKey: (item: Item) => string;
    renderRow: (item: Item, index: number, rowProps: RowProps & { key: string }) => ReactNode;
    /** A typical row height in pixels; real heights are measured as rows render. */
    estimateSize?: number;
};

export function VirtualRows<Item>({ items, rowKey, renderRow, estimateSize = 100 }: Props<Item>)
{
    if (items.length < VIRTUALIZE_FROM)
    {
        return <>{items.map((item, index) => renderRow(item, index, { key: rowKey(item) }))}</>;
    }

    return <WindowedRows items={items} rowKey={rowKey} renderRow={renderRow} estimateSize={estimateSize} />;
}

function WindowedRows<Item>({ items, rowKey, renderRow, estimateSize = 100 }: Props<Item>)
{
    // How far down the page the list starts. Banners and progress bars above it come and go,
    // so it's re-measured whenever the page's layout changes size.
    const [scrollMargin, setScrollMargin] = useState(0);
    const listRef = useCallback((node: HTMLDivElement | null) =>
    {
        if (!node)
        {
            return;
        }

        const measure = () => setScrollMargin(node.getBoundingClientRect().top + window.scrollY);
        const observer = new ResizeObserver(measure);

        measure();
        observer.observe(document.body);

        return () => observer.disconnect();
    }, []);
    const virtualizer = useWindowVirtualizer({
        count: items.length,
        estimateSize: () => estimateSize,
        overscan: 8,
        scrollMargin,
        getItemKey: index => rowKey(items[index]),
    });

    return (
        <div ref={listRef} className="virtual-rows" style={{ position: 'relative', height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map(row =>
                renderRow(items[row.index], row.index, {
                    key: String(row.key),
                    ref: virtualizer.measureElement,
                    'data-index': row.index,
                    style: {
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${row.start - scrollMargin}px)`,
                    },
                })
            )}
        </div>
    );
}
