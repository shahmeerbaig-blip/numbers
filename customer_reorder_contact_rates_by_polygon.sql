-- Re-order rate and customer support contact rate for orders picked up
-- inside vs. outside a given polygon, over a defined time range.
--
-- Definitions:
--   * Segment (Inside / Outside): based on the delivery's PICKUP location
--     falling inside the polygon (dropoff is required to be inside the
--     polygon for all rows, matching the original filter logic).
--   * Re-order rate: % of unique customers (analytical_customer_id) who
--     placed more than one completed rider order in the period, within
--     that segment.
--   * Customer contact rate: % of orders where the CUSTOMER (not rider/
--     vendor) raised a support contact (fct_contact.stakeholder_id = 1),
--     matched by order_id, allowing contacts up to 7 days after the
--     period ends (customers often contact support after delivery).

WITH polygon AS (
  SELECT ST_GEOGFROMGEOJSON("""
{
    "type": "Polygon",
    "coordinates": [
        [
            [51.490757178674365, 25.564584992929518],
            [51.4951515206168  , 25.585960602245   ],
            [51.4934367746814  , 25.5926154455015  ],
            [51.5143793094996  , 25.6071672721741  ],
            [51.5413292419775  , 25.6155262087119  ],
            [51.5511138026107  , 25.6234203554341  ],
            [51.5538587763556  , 25.6385845607472  ],
            [51.5529998567903  , 25.6514281412961  ],
            [51.5571194541309  , 25.6568464997884  ],
            [51.5547165930959  , 25.6628800863957  ],
            [51.5401271221944  , 25.6636555781131  ],
            [51.5327457902045  , 25.6724710037404  ],
            [51.5401255904931  , 25.6778857598296  ],
            [51.5401250237636  , 25.6862361281306  ],
            [51.5270794330638  , 25.6845438759304  ],
            [51.5193554369515  , 25.688407966417   ],
            [51.5040782789853  , 25.6902657935311  ],
            [51.4936061997745  , 25.6966090864669  ],
            [51.4412522062321  , 25.6884088696055  ],
            [51.4419366920411  , 25.684696062182   ],
            [51.3976497110246  , 25.6409140093357  ],
            [51.3948149234813  , 25.643693001828   ],
            [51.3748341        , 25.6100319        ],
            [51.400729291079315, 25.57209055023167 ],
            [51.44401190823734 , 25.575889693950284],
            [51.490757178674365, 25.564584992929518]
        ]
    ]
}

""") AS geom
),

-- All completed rider orders in the period, tagged Inside/Outside by pickup location
base AS (
  SELECT
    fct_logistics_order.order_id,
    fct_order_info.analytical_customer_id,
    CASE
      WHEN fct_logistics_delivery.pickup_location_latitude IS NULL
        OR fct_logistics_delivery.pickup_location_longitude IS NULL THEN NULL
      WHEN ST_CONTAINS(p.geom, ST_GEOGPOINT(
        fct_logistics_delivery.pickup_location_longitude,
        fct_logistics_delivery.pickup_location_latitude)) THEN 'Inside'
      ELSE 'Outside'
    END AS pickup_polygon_check
  FROM `tlb-data-prod.data_platform.fct_logistics_order` AS fct_logistics_order
  LEFT JOIN `tlb-data-prod.data_platform.fct_order_info` AS fct_order_info
    ON fct_logistics_order.order_id = fct_order_info.order_id
    AND fct_logistics_order.is_talabat
    AND fct_order_info.order_date >= DATE('2026-07-01')
    AND fct_order_info.order_date < DATE_ADD(DATE('2026-08-23'), INTERVAL 1 MONTH)
  LEFT JOIN `tlb-data-prod.data_platform.fct_logistics_delivery` AS fct_logistics_delivery
    ON fct_logistics_order.country_code = fct_logistics_delivery.country_code
    AND fct_logistics_order.order_code = fct_logistics_delivery.order_code
    AND fct_logistics_delivery.created_date >= DATE('2026-07-01')
    AND fct_logistics_delivery.created_date < DATE_ADD(DATE('2026-08-23'), INTERVAL 1 MONTH)
  CROSS JOIN polygon p
  WHERE upper(fct_logistics_order.country_code) LIKE 'QA'
    AND fct_logistics_order.created_date >= DATE('2026-07-01')
    AND fct_logistics_order.created_date < DATE_ADD(DATE('2026-08-23'), INTERVAL 1 MONTH)
    AND fct_logistics_order.is_rider_order
    AND upper(fct_logistics_delivery.delivery_status) = 'COMPLETED'
    AND (fct_logistics_delivery.sp_id NOT IN (21108, 21089, 21100) OR fct_logistics_delivery.sp_id IS NULL)
    AND fct_logistics_delivery.dropoff_location_latitude IS NOT NULL
    AND ST_CONTAINS(
      p.geom,
      ST_GEOGPOINT(fct_logistics_delivery.dropoff_location_longitude, fct_logistics_delivery.dropoff_location_latitude)
    )
    AND fct_order_info.analytical_customer_id IS NOT NULL
),

-- Flag each order for whether the customer (stakeholder_id = 1) raised a support contact
base_with_contact AS (
  SELECT
    base.order_id,
    base.analytical_customer_id,
    base.pickup_polygon_check,
    MAX(CASE WHEN fct_contact.stakeholder_id = 1 THEN 1 ELSE 0 END) AS was_contacted_by_customer
  FROM base
  LEFT JOIN `tlb-data-prod.data_platform.fct_contact` AS fct_contact
    ON CAST(base.order_id AS STRING) = fct_contact.order_id
    AND fct_contact.contact_date_utc >= DATE('2026-07-01')
    AND fct_contact.contact_date_utc < DATE_ADD(DATE_ADD(DATE('2026-08-23'), INTERVAL 1 MONTH), INTERVAL 7 DAY)
  WHERE base.pickup_polygon_check IS NOT NULL
  GROUP BY base.order_id, base.analytical_customer_id, base.pickup_polygon_check
),

-- Per-customer, per-segment order counts and contact counts
customer_agg AS (
  SELECT
    analytical_customer_id,
    pickup_polygon_check,
    COUNT(DISTINCT order_id) AS orders_count,
    SUM(was_contacted_by_customer) AS contacted_orders
  FROM base_with_contact
  GROUP BY analytical_customer_id, pickup_polygon_check
)

-- Final: re-order rate and customer contact rate by polygon segment
SELECT
  pickup_polygon_check,
  COUNT(DISTINCT analytical_customer_id) AS unique_customers,
  SUM(orders_count) AS total_orders,
  COUNT(DISTINCT CASE WHEN orders_count > 1 THEN analytical_customer_id END) AS repeat_customers,
  ROUND(
    COUNT(DISTINCT CASE WHEN orders_count > 1 THEN analytical_customer_id END) * 100.0 /
    NULLIF(COUNT(DISTINCT analytical_customer_id), 0), 2
  ) AS reorder_rate_pct,
  SUM(contacted_orders) AS total_contacted_orders,
  ROUND(
    SUM(contacted_orders) * 100.0 / NULLIF(SUM(orders_count), 0), 2
  ) AS customer_contact_rate_pct
FROM customer_agg
GROUP BY pickup_polygon_check
ORDER BY pickup_polygon_check DESC;
