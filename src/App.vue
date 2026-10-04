<script>
    export default {
        onLaunch() {
            console.log('uview-plus4-vue3 launch')
        },
        onShow() {
            console.log('uview-plus4-vue3 show')
        },
        onHide() {
            console.log('uview-plus4-vue3 hide')
        },
    }
</script>

<style lang="scss">
    @import '@/uni_modules/uview-ultra/index.scss';
    /* 示例页的版式（u-page / u-demo-block 等），与 uview-plus4 共用同一份 */
    @import '@/common/demo.scss';

    page,
    body {
        background-color: #f5f6fa;
    }
</style>
