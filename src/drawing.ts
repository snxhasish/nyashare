import chalk from 'chalk';

interface BoxStyle {
    tl: string;
    tr: string;
    bl: string;
    br: string;
    h: string;
    v: string;
    cross: string;
    lJoin: string;
    rJoin: string;
    tJoin: string;
    bJoin: string;
}

export class TerminalDrawing {
    static readonly BOX_LIGHT: BoxStyle = {
        tl: '┌', tr: '┐', bl: '└', br: '┘',
        h: '─', v: '│', cross: '┼',
        lJoin: '├', rJoin: '┤', tJoin: '┬', bJoin: '┴'
    };

    static readonly BOX_HEAVY: BoxStyle = {
        tl: '┏', tr: '┓', bl: '┗', br: '┛',
        h: '━', v: '┃', cross: '╋',
        lJoin: '┣', rJoin: '┫', tJoin: '┳', bJoin: '┻'
    };

    static readonly BOX_DOUBLE: BoxStyle = {
        tl: '╔', tr: '╗', bl: '╚', br: '╝',
        h: '═', v: '║', cross: '╬',
        lJoin: '╠', rJoin: '╣', tJoin: '╦', bJoin: '╩'
    };

    static box(
        content: string,
        options: {
            title?: string;
            width?: number;
            style?: 'light' | 'heavy' | 'double';
            color?: typeof chalk.Color;
        } = {}
    ): string {
        const { title = '', width, style = 'light', color } = options;

        const styles = {
            light: this.BOX_LIGHT,
            heavy: this.BOX_HEAVY,
            double: this.BOX_DOUBLE,
        };
        const box = styles[style];

        const lines = content.split('\n');
        const contentWidth = width ?? Math.max(...lines.map(l => l.length));

        let finalWidth = contentWidth;
        if (title) {
            finalWidth = Math.max(finalWidth, title.length + 2);
        }

        const colorFn = color ? chalk[color] : (s: string) => s;

        let top: string;
        if (title) {
            const titleDisplay = ` ${title} `;
            const padding = finalWidth - titleDisplay.length;
            top = colorFn(`${box.tl}${box.h.repeat(2)}${titleDisplay}${box.h.repeat(padding)}${box.tr}`);
        } else {
            top = colorFn(`${box.tl}${box.h.repeat(finalWidth + 4)}${box.tr}`);
        }

        const contentLines = lines.map(line => {
            const padded = line.padEnd(finalWidth);
            return `${colorFn(box.v)}  ${padded}  ${colorFn(box.v)}`;
        });

        const bottom = colorFn(`${box.bl}${box.h.repeat(finalWidth + 4)}${box.br}`);

        return [top, ...contentLines, bottom].join('\n');
    }

    static table(
        headers: string[],
        rows: string[][],
        options: { style?: 'light' | 'heavy' | 'double' } = {}
    ): string {
        const { style = 'light' } = options;

        const styles = {
            light: this.BOX_LIGHT,
            heavy: this.BOX_HEAVY,
            double: this.BOX_DOUBLE,
        };
        const box = styles[style];

        const colWidths = headers.map((h, i) => {
            const maxRowWidth = Math.max(...rows.map(row => String(row[i] || '').length));
            return Math.max(h.length, maxRowWidth);
        });

        const makeRow = (cells: string[], widths: number[]) => {
            const padded = cells.map((cell, i) => String(cell).padEnd(widths[i]));
            return `${box.v} ${padded.join(' │ ')} ${box.v}`;
        };

        const topParts = colWidths.map(w => box.h.repeat(w + 2));
        const top = `${box.tl}${topParts.join(box.tJoin)}${box.tr}`;

        const headerRow = makeRow(headers, colWidths);

        const sepParts = colWidths.map(w => box.h.repeat(w + 2));
        const separator = `${box.lJoin}${sepParts.join(box.cross)}${box.rJoin}`;

        const dataRows = rows.map(row => makeRow(row, colWidths));

        const bottomParts = colWidths.map(w => box.h.repeat(w + 2));
        const bottom = `${box.bl}${bottomParts.join(box.bJoin)}${box.br}`;

        return [top, headerRow, separator, ...dataRows, bottom].join('\n');
    }

    static progressBar(
        current: number,
        total: number,
        options: {
            width?: number;
            label?: string;
            showPercent?: boolean;
            color?: typeof chalk.Color;
        } = {}
    ): string {
        const { width = 40, label = '', showPercent = true, color } = options;

        const percent = total > 0 ? current / total : 0;
        const filled = Math.floor(width * percent);

        const colorFn = color ? chalk[color] : (s: string) => s;

        const filledBar = colorFn('█'.repeat(filled));
        const emptyBar = chalk.gray('░'.repeat(width - filled));
        const bar = filledBar + emptyBar;

        let result = label ? `${label}: ` : '';
        result += `[${bar}]`;

        if (showPercent) {
            result += ` ${(percent * 100).toFixed(1)}%`;
        }

        return result;
    }

    static tree(
        items: Record<string, any>,
        prefix: string = '',
        isLast: boolean = true
    ): string {
        const lines: string[] = [];
        const keys = Object.keys(items);

        keys.forEach((key, index) => {
            const isLastItem = index === keys.length - 1;

            const connector = isLastItem ? '└── ' : '├── ';
            lines.push(`${prefix}${connector}${key}`);

            // If there are children, recursively draw them
            const children = items[key];
            if (children && typeof children === 'object' && Object.keys(children).length > 0) {
                const extension = isLastItem ? '    ' : '│   ';
                const childLines = this.tree(children, prefix + extension, isLastItem);
                lines.push(childLines);
            }
        });

        return lines.join('\n');
    }

    static banner(
        text: string,
        options: {
            width?: number;
            color?: typeof chalk.Color;
        } = {}
    ): string {
        const { width = 60, color = 'cyan' } = options;

        const padding = Math.floor((width - text.length) / 2);
        const border = '═'.repeat(width);

        const colorFn = chalk[color].bold;

        return `
${colorFn(border)}
${colorFn(' '.repeat(padding) + text + ' '.repeat(padding))}
${colorFn(border)}
`;
    }

    static spinner(text: string = 'Loading'): {
        start: () => void;
        stop: (message?: string) => void;
    } {
        const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
        let currentFrame = 0;
        let intervalId: NodeJS.Timeout | null = null;

        return {
            start: () => {
                process.stdout.write('\x1B[?25l');
                intervalId = setInterval(() => {
                    const frame = frames[currentFrame];
                    process.stdout.write(`\r${chalk.cyan(frame)} ${text}...`);
                    currentFrame = (currentFrame + 1) % frames.length;
                }, 80);
            },
            stop: (message?: string) => {
                if (intervalId) {
                    clearInterval(intervalId);
                    process.stdout.write('\r\x1B[K');
                    if (message) {
                        console.log(`${chalk.green('✓')} ${message}`);
                    }
                    process.stdout.write('\x1B[?25h');
                }
            }
        };
    }

    static clear(): void {
        console.clear();
    }

    static status(
        type: 'success' | 'error' | 'warning' | 'info',
        message: string
    ): string {
        const icons = {
            success: chalk.green('✓'),
            error: chalk.red('✗'),
            warning: chalk.yellow('⚠'),
            info: chalk.blue('ℹ')
        };

        return `${icons[type]} ${message}`;
    }

    static divider(width: number = 80, char: string = '─'): string {
        return chalk.dim(char.repeat(width));
    }
}

export const {
    box,
    table,
    progressBar,
    tree,
    banner,
    spinner,
    clear,
    status,
    divider
} = TerminalDrawing;