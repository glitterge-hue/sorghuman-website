#!/usr/bin/env python3
"""
sorghuman-erp 从网站拉取门店补货单 → 生成销售订单
只有 Sorghuman 自己用；别的批发商在网站后台点点就行，不需要 ERP。

用法：加个定时任务，或在 ERP 里做个「同步网站订单」按钮
    python3 pull_web_pos.py
"""
import os, requests, datetime

API         = "https://sorghuman.com/.netlify/functions/distributor-portal"
SUPPLIER_ID = "sorghuman"
TOKEN       = os.environ["SORGHUMAN_SUPPLIER_TOKEN"]   # 与 distributors.admin_token 一致


def call(action, **kw):
    r = requests.post(API, json={"action": action, "distributorId": SUPPLIER_ID,
                                 "token": TOKEN, **kw}, timeout=30)
    r.raise_for_status()
    data = r.json()
    if data.get("error"):
        raise RuntimeError(data["error"])
    return data


def main():
    # 只拉 ERP 还没导过的单
    pos = call("GET_POS", unsynced=True)["pos"]
    if not pos:
        print("没有新补货单")
        return

    imported = []
    for po in pos:
        # 只导已确认的（避免把还没接的单先进了 ERP）
        if po["status"] not in ("confirmed", "shipped", "received"):
            continue

        store = po.get("stores") or {}
        print(f'{po["po_number"]}  {store.get("name_zh", po["store_id"])}  ${po["total"]}')

        # ── 在这里写进你的 ERP ──────────────────────────────────
        # from models import db, SalesOrder, SalesOrderLine
        # so = SalesOrder(
        #     order_no    = po["po_number"],          # 直接复用 PO 号，两边对得上
        #     customer_id = map_store_to_customer(po["store_id"]),
        #     order_date  = po["created_at"][:10],
        #     status      = "confirmed",              # 库存在 confirmed 时扣减
        #     source      = "web",
        #     note        = po.get("store_note"),
        # )
        # for l in po["items"]:
        #     so.lines.append(SalesOrderLine(
        #         sku       = l["sku"],
        #         quantity  = l["cases"] * l["units_per_case"],   # ERP 按件存，网站按箱卖
        #         unit_price= l["case_price"] / l["units_per_case"],
        #     ))
        # db.session.add(so)
        # db.session.commit()
        # ────────────────────────────────────────────────────────

        imported.append(po["id"])

    if imported:
        call("MARK_SYNCED", poIds=imported)
        print(f"✅ 已导入 {len(imported)} 张，并标记 erp_synced_at")


if __name__ == "__main__":
    main()
