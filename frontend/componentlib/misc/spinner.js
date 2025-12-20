/**
 * Spinner - Loading spinner/indicator
 */
import { defineComponent, html, when } from '../../lib/framework.js';

export default defineComponent('cl-spinner', {
    props: {
        size: 'medium', // 'small', 'medium', 'large', or pixel value like '48px'
        variant: 'border', // 'border', 'dots', 'bars', 'pulse'
        color: '',
        label: '',
        labelposition: 'bottom' // 'bottom', 'right'
    },

    template() {
        const variant = this.props.variant || 'border';
        const sizeClass = ['small', 'medium', 'large'].includes(this.props.size)
            ? this.props.size
            : '';
        const customSize = !sizeClass ? this.props.size : '';

        const colorStyle = this.props.color ? `--spinner-color: ${this.props.color};` : '';
        const sizeStyle = customSize ? `--spinner-size: ${customSize};` : '';
        const combinedStyle = colorStyle + sizeStyle;

        return html`
            <div class="cl-spinner-wrapper ${this.props.labelposition || 'bottom'}" style="${combinedStyle}">
                <div class="spinner ${variant} ${sizeClass}">
                    ${when(variant === 'dots', html`
                        <span class="dot"></span>
                        <span class="dot"></span>
                        <span class="dot"></span>
                    `)}
                    ${when(variant === 'bars', html`
                        <span class="bar"></span>
                        <span class="bar"></span>
                        <span class="bar"></span>
                        <span class="bar"></span>
                    `)}
                </div>
                ${when(this.props.label, html`
                    <span class="spinner-label">${this.props.label}</span>
                `)}
            </div>
        `;
    },

    styles: /*css*/`
        :host {
            display: inline-block;
        }

        .cl-spinner-wrapper {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
            --spinner-color: var(--primary-color, #007bff);
            --spinner-size: 40px;
        }

        .cl-spinner-wrapper.bottom {
            flex-direction: column;
        }

        .cl-spinner-wrapper.right {
            flex-direction: row;
        }

        /* Size variants */
        .spinner.small {
            --spinner-size: 20px;
        }

        .spinner.medium {
            --spinner-size: 40px;
        }

        .spinner.large {
            --spinner-size: 64px;
        }

        /* Border spinner (default) */
        .spinner.border {
            width: var(--spinner-size);
            height: var(--spinner-size);
            border: 3px solid rgba(0, 0, 0, 0.1);
            border-top-color: var(--spinner-color);
            border-radius: 50%;
            animation: spinRotate 0.8s linear infinite;
        }

        .spinner.border.small {
            border-width: 2px;
        }

        .spinner.border.large {
            border-width: 4px;
        }

        /* Pulse spinner */
        .spinner.pulse {
            width: var(--spinner-size);
            height: var(--spinner-size);
            background: var(--spinner-color);
            border-radius: 50%;
            animation: pulse 1.2s ease-in-out infinite;
        }

        /* Dots spinner */
        .spinner.dots {
            display: flex;
            gap: calc(var(--spinner-size) * 0.15);
            align-items: center;
            height: var(--spinner-size);
        }

        .spinner.dots .dot {
            width: calc(var(--spinner-size) * 0.25);
            height: calc(var(--spinner-size) * 0.25);
            background: var(--spinner-color);
            border-radius: 50%;
            animation: dots 1.4s ease-in-out infinite;
        }

        .spinner.dots .dot:nth-child(1) {
            animation-delay: 0s;
        }

        .spinner.dots .dot:nth-child(2) {
            animation-delay: 0.2s;
        }

        .spinner.dots .dot:nth-child(3) {
            animation-delay: 0.4s;
        }

        /* Bars spinner */
        .spinner.bars {
            display: flex;
            gap: calc(var(--spinner-size) * 0.08);
            align-items: center;
            height: var(--spinner-size);
        }

        .spinner.bars .bar {
            width: calc(var(--spinner-size) * 0.12);
            height: calc(var(--spinner-size) * 0.5);
            background: var(--spinner-color);
            border-radius: 2px;
            animation: bars 1.2s ease-in-out infinite;
        }

        .spinner.bars .bar:nth-child(1) {
            animation-delay: 0s;
        }

        .spinner.bars .bar:nth-child(2) {
            animation-delay: 0.1s;
        }

        .spinner.bars .bar:nth-child(3) {
            animation-delay: 0.2s;
        }

        .spinner.bars .bar:nth-child(4) {
            animation-delay: 0.3s;
        }

        .spinner-label {
            font-size: 14px;
            color: var(--text-color, #666);
        }

        @keyframes spinRotate {
            0% {
                transform: rotate(0deg);
            }
            100% {
                transform: rotate(360deg);
            }
        }

        @keyframes pulse {
            0%, 100% {
                transform: scale(0.8);
                opacity: 0.5;
            }
            50% {
                transform: scale(1);
                opacity: 1;
            }
        }

        @keyframes dots {
            0%, 80%, 100% {
                transform: scale(0.6);
                opacity: 0.5;
            }
            40% {
                transform: scale(1);
                opacity: 1;
            }
        }

        @keyframes bars {
            0%, 40%, 100% {
                transform: scaleY(0.5);
                opacity: 0.5;
            }
            20% {
                transform: scaleY(1);
                opacity: 1;
            }
        }
    `
});
