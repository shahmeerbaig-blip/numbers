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

-- Get all customer orders with polygon categorization
customer_orders AS (
  SELECT
    fct_order_info.customer_analytical_id,
    fct_logistics_order.order_id,
    fct_logistics_order.created_date,
    CASE
      WHEN fct_logistics_delivery.pickup_location_latitude IS NULL
        OR fct_logistics_delivery.pickup_location_longitude IS NULL THEN NULL
      WHEN ST_CONTAINS(p.geom, ST_GEOGPOINT(
        fct_logistics_delivery.pickup_location_longitude,
        fct_logistics_delivery.pickup_location_latitude)) THEN 'Inside'
      ELSE 'Outside'
    END AS pickup_polygon_check,
    fct_logistics_delivery.delivery_status,
    fct_logistics_delivery.is_returning,
    fct_logistics_delivery.at_customer_time,
    fct_logistics_delivery.to_customer_time,
    CASE
      WHEN fct_logistics_order.created_date >= DATE('2026-07-01')
        AND fct_logistics_order.created_date < DATE_ADD(DATE('2026-08-23'), INTERVAL 1 MONTH)
      THEN 1
      ELSE 0
    END AS in_analysis_period,
    ROW_NUMBER() OVER (
      PARTITION BY fct_order_info.customer_analytical_id,
        CASE
          WHEN fct_logistics_delivery.pickup_location_latitude IS NULL
            OR fct_logistics_delivery.pickup_location_longitude IS NULL THEN NULL
          WHEN ST_CONTAINS(p.geom, ST_GEOGPOINT(
            fct_logistics_delivery.pickup_location_longitude,
            fct_logistics_delivery.pickup_location_latitude)) THEN 'Inside'
          ELSE 'Outside'
        END
      ORDER BY fct_logistics_order.created_date
    ) AS order_sequence
  FROM `tlb-data-prod.data_platform.fct_logistics_order` AS fct_logistics_order
  LEFT JOIN `tlb-data-prod.data_platform.fct_order_info` AS fct_order_info
    ON fct_logistics_order.order_id = fct_order_info.order_id
    AND fct_logistics_order.is_talabat
  LEFT JOIN `tlb-data-prod.data_platform.fct_logistics_delivery` AS fct_logistics_delivery
    ON fct_logistics_order.country_code = fct_logistics_delivery.country_code
    AND fct_logistics_order.order_code = fct_logistics_delivery.order_code
  CROSS JOIN polygon p
  WHERE upper(fct_logistics_order.country_code) LIKE 'QA'
    AND fct_logistics_order.is_rider_order
    AND upper(fct_logistics_delivery.delivery_status) = 'COMPLETED'
    AND (fct_logistics_delivery.sp_id NOT IN (21108, 21089, 21100) OR fct_logistics_delivery.sp_id IS NULL)
    AND fct_logistics_order.created_date >= DATE_TRUNC(DATE_ADD(CURRENT_DATE(), INTERVAL -23 MONTH), MONTH)
    AND fct_logistics_delivery.dropoff_location_latitude IS NOT NULL
    AND ST_CONTAINS(
      p.geom,
      ST_GEOGPOINT(fct_logistics_delivery.dropoff_location_longitude, fct_logistics_delivery.dropoff_location_latitude)
    )
),

-- Calculate metrics by customer and polygon location
customer_polygon_metrics AS (
  SELECT
    customer_analytical_id,
    pickup_polygon_check,
    COUNT(DISTINCT CASE WHEN in_analysis_period = 1 THEN order_id END) AS orders_in_period,
    COUNT(DISTINCT order_id) AS total_orders_in_history,
    COUNT(DISTINCT CASE WHEN is_returning = TRUE THEN order_id END) AS returning_orders,
    ROUND(
      COUNT(DISTINCT CASE WHEN is_returning = TRUE THEN order_id END) * 100.0 /
      NULLIF(COUNT(DISTINCT order_id), 0),
      2
    ) AS reorder_rate_pct,
    ROUND(AVG(at_customer_time / 60), 2) AS avg_at_customer_time_minutes,
    ROUND(AVG(to_customer_time / 60), 2) AS avg_to_customer_time_minutes,
    COUNT(DISTINCT CASE WHEN at_customer_time > 0 THEN order_id END) AS orders_with_customer_contact,
    ROUND(
      COUNT(DISTINCT CASE WHEN at_customer_time > 0 THEN order_id END) * 100.0 /
      NULLIF(COUNT(DISTINCT order_id), 0),
      2
    ) AS customer_contact_rate_pct
  FROM customer_orders
  WHERE order_sequence > 1 OR in_analysis_period = 1
  GROUP BY customer_analytical_id, pickup_polygon_check
)

-- Final aggregation by polygon location
SELECT
  pickup_polygon_check,
  COUNT(DISTINCT customer_analytical_id) AS unique_customers,
  SUM(orders_in_period) AS total_orders_in_period,
  SUM(total_orders_in_history) AS total_orders_in_history,
  SUM(returning_orders) AS total_returning_orders,
  ROUND(AVG(reorder_rate_pct), 2) AS avg_reorder_rate_pct,
  ROUND(AVG(customer_contact_rate_pct), 2) AS avg_customer_contact_rate_pct,
  ROUND(AVG(avg_at_customer_time_minutes), 2) AS avg_at_customer_time_minutes,
  ROUND(AVG(avg_to_customer_time_minutes), 2) AS avg_to_customer_time_minutes
FROM customer_polygon_metrics
WHERE pickup_polygon_check IS NOT NULL
GROUP BY pickup_polygon_check
ORDER BY pickup_polygon_check DESC;
