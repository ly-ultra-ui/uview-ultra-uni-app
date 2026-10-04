<template>
    <view class="index">
        <view class="index__hd">
            <text class="index__title">uview-ultra · uni-app Vue3 冒烟</text>
            <text class="index__meta">{{ componentCount }} 个组件已进入编译 · {{ pageCount }} 个示例页</text>
        </view>

        <view v-for="group in groups" :key="group.name" class="index__group">
            <text class="index__group-title">{{ group.name }}</text>
            <view
                v-for="item in group.items"
                :key="item.path"
                class="index__item"
                @tap="open(item.path)"
            >
                <text class="index__item-title">{{ item.title }}</text>
                <text class="index__item-path">{{ item.path }}</text>
            </view>
        </view>
    </view>
</template>

<script setup>
import groups from './demo-manifest.js'

/**
 * eager 展开 uview-ultra 下所有 .vue 组件，保证每一个都真实经过 uni-app Vue3 编译链。
 * 即使示例页没用到它，也不会躺在仓库里没人编译。
 */
const modules = import.meta.glob('../../uni_modules/uview-ultra/components/up-*/*.vue', { eager: true })
const componentCount = Object.keys(modules).length

const pageCount = groups.reduce((total, group) => total + group.items.length, 0)

function open(path) {
    uni.navigateTo({ url: '/' + path })
}
</script>

<style lang="scss" scoped>
.index {
    padding: 24rpx;

    &__hd {
        padding: 24rpx;
        background-color: #ffffff;
        border-radius: 16rpx;
        margin-bottom: 20rpx;
    }

    &__title {
        display: block;
        font-size: 34rpx;
        font-weight: 500;
        color: #303133;
    }

    &__meta {
        display: block;
        margin-top: 8rpx;
        font-size: 24rpx;
        color: #909399;
    }

    &__group {
        background-color: #ffffff;
        border-radius: 16rpx;
        padding: 8rpx 24rpx 16rpx;
        margin-bottom: 20rpx;
    }

    &__group-title {
        display: block;
        padding: 16rpx 0 8rpx;
        font-size: 26rpx;
        font-weight: 500;
        color: #303133;
    }

    &__item {
        padding: 16rpx 0;
        border-bottom: 1rpx solid #f2f3f5;
    }

    &__item-title {
        display: block;
        font-size: 26rpx;
        color: #303133;
    }

    &__item-path {
        display: block;
        margin-top: 4rpx;
        font-size: 22rpx;
        color: #c0c4cc;
    }
}
</style>
