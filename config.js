"use strict";
import $ from 'jquery';
import {findModel} from "./models.js";

export function Config(onClose) {
    let changed = {};
    this.model = null;
    const $configuration = document.getElementById('configuration');
    $configuration.addEventListener('show.bs.modal', () => changed = {});
    $configuration.addEventListener('hide.bs.modal', () => onClose(changed));

    this.setModel = function (modelName) {
        this.model = findModel(modelName);
        $(".bbc-model").text(this.model.name);
    };

    this.setKeyLayout = function (keyLayout) {
        $(".keyboard-layout").text(keyLayout[0].toUpperCase() + keyLayout.substr(1));
    };

    $('.model-menu a').on("click", function (e) {
        const modelName = $(e.target).attr("data-target");
        changed.model = modelName;
        this.setModel(modelName);
    }.bind(this));

    $('.keyboard-menu a').on("click", function (e) {
        const keyLayout = $(e.target).attr("data-target");
        changed.keyLayout = keyLayout;
        this.setKeyLayout(keyLayout);
    }.bind(this));
}