/**
 * Augment the typings of Vue.js
 */
import vue from '@vue/runtime-core';
import VueLogger from '../../index';

export interface Log {
    debug(...args: any[]): void;

    info(...args: any[]): void;

    warn(...args: any[]): void;

    error(...args: any[]): void;

    fatal(...args: any[]): void;
}


declare module '@vue/runtime-core' {
    export interface ComponentCustomProperties {
        $log: Log;
    }
}

export default VueLogger;
